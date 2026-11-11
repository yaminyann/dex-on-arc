import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, type Address } from 'viem'
import { Gateway, NEUTRAL_TAKER, withTakerAllowance } from '../server/gateway/gateway'
import { createTestRouterProvider, testRouterAbi, type TestRouterReader } from '../server/gateway/testrouter'
import type { GatewayRequest } from '../server/gateway/types'
import { parseQuoteRequest, isApiError } from '../server/zerox'

const ROUTER_A = '0x6812943fc8cf6acf9a098cbabb2277112d77a93f' as Address
const ROUTER_B = '0x5efcfe5aecbf618c149288496289d305edf107bd' as Address
const USDC = '0x3600000000000000000000000000000000000000'
const TBTC = '0x661bf226688f011115a84f5a1243ca6b467c8dfe'
const TAKER = '0x0000000000000000000000000000000000000001'
const req: GatewayRequest = { chainId: 5042002, sellToken: USDC, buyToken: TBTC, sellAmount: '1000000', taker: TAKER, slippageBps: 50 }

function reader(quotes: Record<string, bigint | 'revert'>, allowance = 0n): TestRouterReader {
  return {
    quote: async (router) => {
      const q = quotes[router.toLowerCase()]
      if (q === undefined || q === 'revert') throw new Error('NoFeed')
      return q
    },
    allowance: async () => allowance,
  }
}

describe('test router provider (testnet)', () => {
  test('quotes, builds swapExactIn calldata and reports a missing allowance', async () => {
    const p = createTestRouterProvider({ id: 'test-router', router: ROUTER_A, chainId: 5042002, reader: reader({ [ROUTER_A]: 13_000n }) })
    const res = await p.fetch('quote', req, new AbortController().signal)
    if (res.kind !== 'quote') throw new Error('expected quote')
    expect(res.quote.buyAmount).toBe(13_000n)
    expect(res.quote.minBuyAmount).toBe(12_935n)
    expect(res.quote.spender).toBe(ROUTER_A)
    expect(res.quote.allowance?.spender).toBe(ROUTER_A)
    const decoded = decodeFunctionData({ abi: testRouterAbi, data: res.quote.transaction!.data as `0x${string}` })
    expect(decoded.functionName).toBe('swapExactIn')
    expect(([...(decoded.args ?? [])] as unknown[]).map((x) => (typeof x === 'string' ? x.toLowerCase() : x))).toEqual([USDC, TBTC, 1_000_000n])
  })

  test('a pair without a feed is no liquidity, not an invented price', async () => {
    const p = createTestRouterProvider({ id: 'test-router', router: ROUTER_A, chainId: 5042002, reader: reader({}) })
    expect((await p.fetch('price', req, new AbortController().signal)).kind).toBe('no_liquidity')
  })

  test('only answers on Arc Testnet', () => {
    const p = createTestRouterProvider({ id: 'test-router', router: ROUTER_A, chainId: 5042002, reader: reader({}) })
    expect(p.supports(5042002)).toBe(true)
    expect(p.supports(5042)).toBe(false)
  })

  test('two routers: best price wins, and a dead one is skipped', async () => {
    const a = createTestRouterProvider({ id: 'test-router', router: ROUTER_A, chainId: 5042002, reader: reader({ [ROUTER_A]: 100n, [ROUTER_B]: 120n }) })
    const b = createTestRouterProvider({ id: 'test-router-b', router: ROUTER_B, chainId: 5042002, reader: reader({ [ROUTER_A]: 100n, [ROUTER_B]: 120n }) })
    const g = new Gateway([a, b])
    expect((await g.rank('price', req)).ranked.map((q) => q.provider)).toEqual(['test-router-b', 'test-router'])
    const dead = createTestRouterProvider({ id: 'test-router-b', router: ROUTER_B, chainId: 5042002, reader: reader({ [ROUTER_A]: 100n }) })
    expect((await new Gateway([a, dead]).rank('price', req)).ranked.map((q) => q.provider)).toEqual(['test-router'])
  })
})

describe('taker-less price caching', () => {
  const shared = { status: 200, body: { liquidityAvailable: true, spender: ROUTER_A, sellAmount: '1000000', issues: { allowance: { spender: ROUTER_A, actual: '0' } } } }

  test('adds the wallet allowance to a shared price', async () => {
    const needs = await withTakerAllowance(shared, req, async () => 0n)
    expect((needs.body as { issues: { allowance: { actual: string } | null } }).issues.allowance?.actual).toBe('0')
    const enough = await withTakerAllowance(shared, req, async () => 5_000_000n)
    expect((enough.body as { issues: { allowance: unknown } }).issues.allowance).toBeNull()
  })

  test('an unreadable allowance is treated as zero', async () => {
    const out = await withTakerAllowance(shared, req, async () => {
      throw new Error('rpc down')
    })
    expect((out.body as { issues: { allowance: unknown } }).issues.allowance).not.toBeNull()
  })

  test('errors and no-liquidity responses pass through untouched', async () => {
    const err = { status: 429, body: { error: { code: 'RATE' } } }
    expect(await withTakerAllowance(err, req, async () => 0n)).toBe(err)
    const none = { status: 200, body: { liquidityAvailable: false } }
    expect(await withTakerAllowance(none, req, async () => 0n)).toBe(none)
  })

  test('the neutral taker is a valid address the request parser accepts', () => {
    const parsed = parseQuoteRequest(new URLSearchParams({ chainId: '5042002', sellToken: USDC, buyToken: TBTC, sellAmount: '1', taker: NEUTRAL_TAKER }), () => true)
    expect(isApiError(parsed)).toBe(false)
  })

  test('request validation uses the supplied chain check', () => {
    const base = { sellToken: USDC, buyToken: TBTC, sellAmount: '1', taker: TAKER }
    expect(isApiError(parseQuoteRequest(new URLSearchParams({ ...base, chainId: '5042002' }), (id) => id === 5042002))).toBe(false)
    const bad = parseQuoteRequest(new URLSearchParams({ ...base, chainId: '1' }), (id) => id === 5042002)
    expect(isApiError(bad) && bad.code).toBe('CHAIN_NOT_SUPPORTED')
  })
})
