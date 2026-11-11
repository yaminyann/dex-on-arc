import { describe, expect, test } from 'bun:test'
import { Gateway } from '../server/gateway/gateway'
import { createKyberProvider, KYBER_ROUTER_DEFAULT, kyberRoute, minOut } from '../server/gateway/kyber'
import { normalizeZeroEx } from '../server/gateway/zeroex'
import type { GatewayQuote, GatewayRequest, ProviderResult, QuoteProvider } from '../server/gateway/types'
import { Alerter } from '../server/alerts'
import { renderPrometheus } from '../server/prometheus'
import { applyGasFloor, expectedFeeUsdc6, gasCostUsdc6, isProfitable, loadKeeperKey, NonceTracker, StandbyGate } from '../server/keeper-core'
import { resolveRpcUrls } from '../server/rpc'

const USDC = '0x3600000000000000000000000000000000000000'
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
const TAKER = '0x0000000000000000000000000000000000000001'
const req: GatewayRequest = { chainId: 5042, sellToken: USDC, buyToken: EURC, sellAmount: '1000000', taker: TAKER, slippageBps: 50 }

function q(provider: string, buy: bigint, over: Partial<GatewayQuote> = {}): GatewayQuote {
  return { provider, sellAmount: 1_000_000n, buyAmount: buy, minBuyAmount: buy, route: [], networkFeeNative: null, allowance: null, ...over }
}

function fake(id: string, result: ProviderResult | (() => Promise<ProviderResult>), over: Partial<QuoteProvider> = {}): QuoteProvider {
  return {
    id,
    configured: () => true,
    supports: () => true,
    fetch: async () => (typeof result === 'function' ? result() : result),
    ...over,
  }
}

describe('gateway ranking', () => {
  test('picks the best guaranteed output and lists alternatives', async () => {
    const g = new Gateway([fake('a', { kind: 'quote', quote: q('a', 900n) }), fake('b', { kind: 'quote', quote: q('b', 950n) })])
    const out = await g.best('price', req)
    expect(out.status).toBe(200)
    const body = out.body as { provider: string; alternatives: { provider: string }[] }
    expect(body.provider).toBe('b')
    expect(body.alternatives.map((a) => a.provider)).toEqual(['b', 'a'])
  })

  test('subtracts gas from the score when the buy token is USDC', async () => {
    // 'cheap' pays 1000 but costs 600 USDC-units of gas; 'dear' pays 800 and costs 0.
    const gasWei = 600n * 10n ** 12n
    const g = new Gateway([fake('cheap', { kind: 'quote', quote: q('cheap', 1000n, { networkFeeNative: gasWei }) }), fake('dear', { kind: 'quote', quote: q('dear', 800n) })], { usdc: { 5042: USDC } })
    const ranked = (await g.rank('price', { ...req, sellToken: EURC, buyToken: USDC })).ranked
    expect(ranked[0].provider).toBe('dear')
  })

  test('a quote that fails simulation is demoted below one that passes', async () => {
    const g = new Gateway([fake('big', async () => ({ kind: 'quote', quote: q('big', 2000n, { transaction: { to: '0x1', data: '0x', value: 0n, gas: null } }) })), fake('small', async () => ({ kind: 'quote', quote: q('small', 1000n, { transaction: { to: '0x2', data: '0x', value: 0n, gas: null } }) }))], {
      simulate: async (_r, quote) => (quote.provider === 'big' ? 'failed' : 'ok'),
    })
    const { ranked } = await g.rank('quote', req)
    expect(ranked.map((x) => x.provider)).toEqual(['small', 'big'])
    expect((await g.rank('quote', req, { simulate: false })).ranked[0].provider).toBe('big')
  })

  test('no liquidity from everyone is a clean "no route", not an error', async () => {
    const g = new Gateway([fake('a', { kind: 'no_liquidity' }), fake('b', { kind: 'no_liquidity' })])
    const out = await g.best('price', req)
    expect(out.status).toBe(200)
    expect((out.body as { liquidityAvailable: boolean }).liquidityAvailable).toBe(false)
  })

  test('one provider failing does not hide the other one', async () => {
    const g = new Gateway([fake('bad', { kind: 'error', status: 500, code: 'X', message: 'boom', retryable: true }), fake('ok', { kind: 'quote', quote: q('ok', 10n) })])
    const out = await g.best('price', req)
    expect((out.body as { provider: string }).provider).toBe('ok')
  })

  test('when every provider errors the real error is surfaced', async () => {
    const g = new Gateway([fake('bad', { kind: 'error', status: 429, code: 'RATE', message: 'slow down', retryable: true })])
    const out = await g.best('price', req)
    expect(out.status).toBe(429)
    expect((out.body as { error: { code: string } }).error.code).toBe('RATE')
  })

  test('unconfigured or unsupported providers are skipped; none configured is reported', async () => {
    const g = new Gateway([fake('a', { kind: 'quote', quote: q('a', 1n) }, { configured: () => false })])
    expect((await g.best('price', req)).status).toBe(503)
    const g2 = new Gateway([fake('a', { kind: 'quote', quote: q('a', 1n) }, { supports: () => false })])
    const r = await g2.rank('price', req)
    expect(r.outcomes[0].outcome).toBe('unsupported')
  })
})

describe('gateway resilience', () => {
  test('breaker opens after repeated failures, skips the provider, then half-opens after the cooldown', async () => {
    let t = 1_000
    let calls = 0
    const flaky = fake('flaky', async () => {
      calls++
      return { kind: 'error', status: 502, code: 'DOWN', message: 'down', retryable: true }
    })
    const g = new Gateway([flaky], { breakerThreshold: 2, breakerCooldownMs: 10_000, now: () => t })
    await g.rank('price', req)
    await g.rank('price', req)
    expect(g.status()[0].breaker).toBe('open')
    const skipped = await g.rank('price', req)
    expect(skipped.outcomes[0].outcome).toBe('breaker_open')
    expect(calls).toBe(2)
    t += 10_001
    await g.rank('price', req)
    expect(calls).toBe(3)
    expect(g.status()[0].breaker).toBe('open')
  })

  test('a success closes the breaker; no_liquidity never counts as a failure', async () => {
    let mode: 'err' | 'none' = 'err'
    const p = fake('p', async () => (mode === 'err' ? { kind: 'error', status: 500, code: 'E', message: 'e', retryable: true } : { kind: 'no_liquidity' }))
    const g = new Gateway([p], { breakerThreshold: 3 })
    await g.rank('price', req)
    await g.rank('price', req)
    mode = 'none'
    await g.rank('price', req)
    expect(g.status()[0].consecutiveFailures).toBe(0)
  })

  test('a slow provider is cut off by the timeout and does not delay the others', async () => {
    const slow = fake('slow', () => new Promise<ProviderResult>(() => {}), {
      fetch: (_k, _r, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    })
    const fast = fake('fast', { kind: 'quote', quote: q('fast', 5n) })
    const g = new Gateway([slow, fast], { timeoutMs: 50 })
    const started = Date.now()
    const out = await g.rank('price', req)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(out.ranked[0].provider).toBe('fast')
    expect(out.outcomes.find((o) => o.provider === 'slow')?.outcome).toBe('timeout')
  })

  test('per-provider budget stops upstream calls once exhausted', async () => {
    let calls = 0
    const p = fake('p', async () => {
      calls++
      return { kind: 'quote', quote: q('p', 1n) }
    })
    const g = new Gateway([p], { budgetPerMin: 2 })
    for (let i = 0; i < 5; i++) await g.rank('price', req)
    expect(calls).toBe(2)
  })
})

// Shape taken from a live response of aggregator-api.kyberswap.com/arc on 2026-11-12.
const KYBER_ROUTE = {
  code: 0,
  message: 'successfully',
  data: {
    routeSummary: {
      tokenIn: USDC,
      amountIn: '1000000',
      tokenOut: EURC.toLowerCase(),
      amountOut: '901241',
      gas: '287581',
      gasPrice: '20001500000',
      route: [[{ pool: '0xpool', tokenIn: USDC, tokenOut: EURC.toLowerCase(), swapAmount: '1000000', amountOut: '901241', exchange: 'pancake-infinity-cl' }]],
    },
    routerAddress: KYBER_ROUTER_DEFAULT,
  },
}
const KYBER_BUILD = { code: 0, message: 'successfully', data: { amountOut: '901241', gas: '287581', data: '0xe21fd0e9aa', routerAddress: KYBER_ROUTER_DEFAULT, transactionValue: '0' } }

function kyberFetch(routeBody: unknown, buildBody: unknown = KYBER_BUILD, seen: { url: string; body?: string }[] = []) {
  return async (input: string, init?: RequestInit) => {
    seen.push({ url: input, body: init?.body as string | undefined })
    const body = input.includes('/route/build') ? buildBody : routeBody
    return new Response(JSON.stringify(body), { status: 200 })
  }
}

describe('kyber provider', () => {
  test('price: normalizes amounts, route, gas and the insufficient-allowance spender', async () => {
    const p = createKyberProvider({ fetchFn: kyberFetch(KYBER_ROUTE), readAllowance: async () => 0n })
    const res = await p.fetch('price', req, new AbortController().signal)
    expect(res.kind).toBe('quote')
    if (res.kind !== 'quote') return
    expect(res.quote.buyAmount).toBe(901241n)
    expect(res.quote.minBuyAmount).toBe(minOut(901241n, 50))
    expect(res.quote.networkFeeNative).toBe(287581n * 20001500000n)
    expect(res.quote.allowance?.spender).toBe(KYBER_ROUTER_DEFAULT)
    expect(res.quote.route[0].source).toBe('pancake-infinity-cl')
    expect(res.quote.route[0].proportionBps).toBe('10000')
    expect(res.quote.transaction).toBeUndefined()
  })

  test('quote: builds calldata for the taker as sender and recipient with the slippage in bps', async () => {
    const seen: { url: string; body?: string }[] = []
    const p = createKyberProvider({ fetchFn: kyberFetch(KYBER_ROUTE, KYBER_BUILD, seen), readAllowance: async () => 5_000_000n })
    const res = await p.fetch('quote', req, new AbortController().signal)
    if (res.kind !== 'quote') throw new Error('expected quote')
    expect(res.quote.transaction?.to).toBe(KYBER_ROUTER_DEFAULT)
    expect(res.quote.transaction?.value).toBe(0n)
    expect(res.quote.allowance).toBeNull()
    const build = JSON.parse(seen.find((s) => s.url.includes('/route/build'))!.body!)
    expect(build.sender).toBe(TAKER)
    expect(build.recipient).toBe(TAKER)
    expect(build.slippageTolerance).toBe(50)
  })

  test('an unreadable allowance is treated as insufficient so the UI asks for an approval', async () => {
    const p = createKyberProvider({ fetchFn: kyberFetch(KYBER_ROUTE), readAllowance: async () => null })
    const res = await p.fetch('price', req, new AbortController().signal)
    if (res.kind !== 'quote') throw new Error('expected quote')
    expect(res.quote.allowance?.actual).toBe(0n)
  })

  test('route not found is no liquidity', async () => {
    const p = createKyberProvider({ fetchFn: kyberFetch({ code: 4008, message: 'route not found' }) })
    expect((await p.fetch('price', req, new AbortController().signal)).kind).toBe('no_liquidity')
  })

  test('refuses an unexpected router address from the API', async () => {
    const bad = { ...KYBER_ROUTE, data: { ...KYBER_ROUTE.data, routerAddress: '0x00000000000000000000000000000000deadbeef' } }
    const p = createKyberProvider({ fetchFn: kyberFetch(bad) })
    const res = await p.fetch('price', req, new AbortController().signal)
    expect(res.kind === 'error' && res.code).toBe('UNTRUSTED_ROUTER')
    const badBuild = { ...KYBER_BUILD, data: { ...KYBER_BUILD.data, routerAddress: '0x00000000000000000000000000000000deadbeef' } }
    const p2 = createKyberProvider({ fetchFn: kyberFetch(KYBER_ROUTE, badBuild) })
    const res2 = await p2.fetch('quote', req, new AbortController().signal)
    expect(res2.kind === 'error' && res2.code).toBe('UNTRUSTED_ROUTER')
  })

  test('refuses a quote for a different amount than requested', async () => {
    const wrong = { ...KYBER_ROUTE, data: { ...KYBER_ROUTE.data, routeSummary: { ...KYBER_ROUTE.data.routeSummary, amountIn: '999' } } }
    const p = createKyberProvider({ fetchFn: kyberFetch(wrong) })
    const res = await p.fetch('price', req, new AbortController().signal)
    expect(res.kind === 'error' && res.code).toBe('AMOUNT_MISMATCH')
  })

  test('only supports Arc mainnet; route shares are in bps of the input', () => {
    const p = createKyberProvider({})
    expect(p.supports(5042)).toBe(true)
    expect(p.supports(5042002)).toBe(false)
    const fills = kyberRoute({ amountIn: '100', amountOut: '1', route: [[{ tokenIn: 'a', tokenOut: 'b', swapAmount: '60', exchange: 'x' }], [{ tokenIn: 'a', tokenOut: 'b', swapAmount: '40', exchange: 'y' }]] })
    expect(fills.map((f) => f.proportionBps)).toEqual(['6000', '4000'])
  })
})

describe('0x normalization', () => {
  test('maps a firm quote and an upstream error', () => {
    const ok = normalizeZeroEx(200, { liquidityAvailable: true, buyAmount: '10', minBuyAmount: '9', sellAmount: '5', route: [], totalNetworkFee: '7', issues: { allowance: { actual: '0', spender: '0xabc' } }, transaction: { to: '0xdef', data: '0x12', value: '0', gas: '100' } })
    expect(ok.kind === 'quote' && ok.quote.allowance?.spender).toBe('0xabc')
    expect(ok.kind === 'quote' && ok.quote.transaction?.gas).toBe(100n)
    expect(normalizeZeroEx(200, { liquidityAvailable: false }).kind).toBe('no_liquidity')
    const err = normalizeZeroEx(429, { error: { code: 'RATE', message: 'm' } })
    expect(err.kind === 'error' && err.retryable).toBe(true)
    expect(normalizeZeroEx(200, { liquidityAvailable: true }).kind).toBe('error')
  })
})

describe('keeper core', () => {
  test('nonces are consecutive from the pending count', () => {
    const n = new NonceTracker(7)
    expect([n.next(), n.next(), n.next()]).toEqual([7, 8, 9])
    expect(n.peek).toBe(10)
  })

  test('gas cost converts the 18-decimal native view to 6-decimal USDC, rounding up', () => {
    expect(gasCostUsdc6(287_581n, 20_001_500_000n)).toBe(5_753n) // 0.00575205 USDC rounded up
    expect(gasCostUsdc6(1n, 1n)).toBe(1n)
  })

  test('expected fee uses the output for sells and the input as the value proxy for buys', () => {
    expect(expectedFeeUsdc6({ outputIsQuoteToken: true, buyAmount: 10_000_000n, sellAmount: 1n, feeBps: 10 })).toBe(10_000n)
    expect(expectedFeeUsdc6({ outputIsQuoteToken: false, buyAmount: 1n, sellAmount: 2_000_000n, feeBps: 10 })).toBe(2_000n)
  })

  test('profitability: fee must cover gas plus margin and the absolute floor', () => {
    const policy = { require: true, marginBps: 0, minFeeUsdc6: 0n }
    // 1 USDC order => fee 1000 micro-USDC (0.10%); gas ~5752 micro-USDC => not worth it
    expect(isProfitable(policy, 1_000n, 287_581n, 20_001_500_000n)).toBe(false)
    // 100 USDC order => fee 100_000 micro-USDC => profitable
    expect(isProfitable(policy, 100_000n, 287_581n, 20_001_500_000n)).toBe(true)
    expect(isProfitable({ ...policy, marginBps: 20_000 }, 10_000n, 287_581n, 20_001_500_000n)).toBe(false)
    expect(isProfitable({ ...policy, minFeeUsdc6: 200_000n }, 100_000n, 287_581n, 20_001_500_000n)).toBe(false)
    expect(isProfitable({ ...policy, require: false }, 0n, 287_581n, 20_001_500_000n)).toBe(true)
  })

  test('gas floor never lets a fee fall below Arc minimum', () => {
    const floor = 20_000_000_000n
    expect(applyGasFloor({ maxFeePerGas: 5n, maxPriorityFeePerGas: 1n }, floor).maxFeePerGas).toBe(floor)
    expect(applyGasFloor({ maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 2n }, floor).maxFeePerGas).toBe(30_000_000_000n)
    expect(applyGasFloor(undefined, floor)).toEqual({ maxFeePerGas: floor, maxPriorityFeePerGas: 0n })
  })

  test('standby only acts after the grace period and forgets cleared items', () => {
    const gate = new StandbyGate(1000)
    expect(gate.observe(['a', 'b'], 0).size).toBe(0)
    expect([...gate.observe(['a', 'b'], 1000)].sort()).toEqual(['a', 'b'])
    // b is handled by the primary and disappears; a new item c starts its own timer.
    expect([...gate.observe(['a', 'c'], 1500)]).toEqual(['a'])
    expect(gate.waiting).toBe(2)
    // b reappears later: its timer restarts.
    expect(gate.observe(['b'], 5000).size).toBe(0)
  })

  test('key loading prefers the file, validates format, never returns the key in errors', () => {
    const key = '0x' + 'ab'.repeat(32)
    expect(loadKeeperKey({ KEEPER_PRIVATE_KEY: key }).key).toBe(key as `0x${string}`)
    expect(loadKeeperKey({ KEEPER_PRIVATE_KEY: '0x00', KEEPER_PRIVATE_KEY_FILE: '/run/secrets/k' }, () => `${key}\n`).key).toBe(key as `0x${string}`)
    expect(loadKeeperKey({ KEEPER_PRIVATE_KEY: key, KEEPER_PRIVATE_KEY_FILE: '/nope' }, () => { throw new Error('ENOENT') }).error).toContain('could not be read')
    const bad = loadKeeperKey({ KEEPER_PRIVATE_KEY: 'nope' })
    expect(bad.key).toBeUndefined()
    expect(JSON.stringify(bad)).not.toContain('nope')
  })
})

describe('rpc selection', () => {
  test('accepts a comma-separated list and prefers it over the proxy and public RPC', () => {
    expect(resolveRpcUrls('Arc', ['https://public'], { RPC_URL_Arc: 'https://a, https://b' })).toEqual(['https://a', 'https://b'])
    expect(resolveRpcUrls('Arc', ['https://public'], { RPC_PROXY_CHAINS: 'Arc', RPC_PROXY_BASE_URL: 'https://p', RPC_PROXY_TOKEN: 't' })[0]).toContain('https://p/api/rpc/Arc')
    expect(resolveRpcUrls('Arc', ['https://public'], {})).toEqual(['https://public'])
  })
})

describe('alerts and metrics', () => {
  test('alerts are deduplicated within the cooldown, redacted, and announce recovery once', async () => {
    const posts: string[] = []
    const logs: string[] = []
    const a = new Alerter('https://hooks.example/x', 1000, async (_u, body) => void posts.push(body), (l) => void logs.push(l))
    expect(await a.raise('k', 'rpc https://node.example/?token=SECRET failed', 0)).toBe(true)
    expect(await a.raise('k', 'again', 500)).toBe(false)
    expect(await a.raise('k', 'again', 1500)).toBe(true)
    expect(posts.join()).not.toContain('SECRET')
    expect(await a.resolve('k')).toBe(true)
    expect(await a.resolve('k')).toBe(false)
  })

  test('without a webhook alerts still log and report nothing sent', async () => {
    const logs: string[] = []
    const a = new Alerter(undefined, 1000, async () => {}, (l) => void logs.push(l))
    expect(await a.raise('k', 'm', 0)).toBe(false)
    expect(logs.length).toBe(1)
  })

  test('prometheus output has typed series and per-provider labels', () => {
    const text = renderPrometheus({
      uptimeSeconds: 5,
      http: { requests: 3, rateLimited: 1, cacheHits: 2, cacheMisses: 1, upstreamErrors: 0 },
      keeper: { ticks: 4, executed: 2, balanceUsdc: 12.5, lastOkTickAt: 0 },
      providers: [{ id: '0x', configured: true, breaker: 'closed', consecutiveFailures: 0 }, { id: 'kyber', configured: true, breaker: 'open', consecutiveFailures: 3 }],
      priceCacheEntries: 1,
      nowMs: 10_000,
    })
    expect(text).toContain('# TYPE arc_http_requests_total counter')
    expect(text).toContain('arc_price_cache_total{result="hit"} 2')
    expect(text).toContain('arc_keeper_balance_usdc 12.5')
    expect(text).toContain('arc_gateway_provider_up{provider="0x"} 1')
    expect(text).toContain('arc_gateway_provider_up{provider="kyber"} 0')
    expect(text).toContain('arc_keeper_last_ok_tick_age_seconds -1')
  })
})
