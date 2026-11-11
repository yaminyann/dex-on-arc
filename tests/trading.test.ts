import { describe, expect, test } from 'bun:test'
import {
  applySlippage,
  averagePrice18,
  baseForQuote,
  buysForDuration,
  formatToken,
  parsePrice18,
  parseTokenAmount,
  quoteForBase,
  WAD,
} from '../src/trading/math'
import { computePositions, unrealizedQuote } from '../src/trading/portfolio'
import { aggregateCandles, ema, sma, type Candle } from '../src/trading/market'
import { parseRawQuote } from '../src/trading/aggregator'
import { DcaStatus, OrderType, Side, Status, type DcaView, type OrderView } from '../src/trading/types'
import { isApiError, parseQuoteRequest } from '../server/zerox'

const ADDR_A = '0x2c4047028a72803939b6fb674D01bC059B5C4961'
const ADDR_B = '0x3600000000000000000000000000000000000000'
const USER = '0x0000000000000000000000000000000000000001'

describe('order math', () => {
  test('quoteForBase and baseForQuote match the contract convention (6-dec quote, 8-dec base)', () => {
    const price = 60_000n * WAD
    // 0.5 BTC (8 dec) at 60,000 USDC = 30,000 USDC (6 dec)
    expect(quoteForBase(50_000_000n, price, 8, 6)).toBe(30_000_000_000n)
    expect(baseForQuote(30_000_000_000n, price, 8, 6)).toBe(50_000_000n)
  })

  test('18-decimal base', () => {
    const price = 2_500n * WAD
    expect(quoteForBase(2n * 10n ** 18n, price, 18, 6)).toBe(5_000_000_000n)
  })

  test('round trip never inflates the amount', () => {
    const price = 1_234_567_890_123_456_789n
    const quote = 987_654_321n
    const base = baseForQuote(quote, price, 8, 6)
    expect(quoteForBase(base, price, 8, 6) <= quote).toBe(true)
  })

  test('zero price yields zero base instead of dividing by zero', () => {
    expect(baseForQuote(1_000_000n, 0n, 8, 6)).toBe(0n)
  })

  test('slippage floor', () => {
    expect(applySlippage(1_000_000n, 50)).toBe(995_000n)
    expect(applySlippage(1_000_000n, 1000)).toBe(900_000n)
  })

  test('parsing rejects bad input', () => {
    expect(parsePrice18('')).toBeNull()
    expect(parsePrice18('abc')).toBeNull()
    expect(parsePrice18('0')).toBeNull()
    expect(parsePrice18('1.5')).toBe(1_500_000_000_000_000_000n)
    expect(parseTokenAmount('1.234567', 6)).toBe(1_234_567n)
    expect(parseTokenAmount('1.2345678', 6)).toBeNull()
    expect(parseTokenAmount('-1', 6)).toBeNull()
  })

  test('formatting', () => {
    expect(formatToken(1_234_567_890n, 6, 2)).toBe('1,234.56')
    expect(formatToken(1_000_000n, 6, 2)).toBe('1')
  })

  test('DCA schedule sizing', () => {
    expect(buysForDuration(30, 86400)).toBe(30)
    expect(buysForDuration(30, 604800)).toBe(4)
    expect(buysForDuration(0.1, 86400)).toBe(1)
    expect(averagePrice18(100_000_000n, 2_000_000n, 6, 6)).toBe(50n * WAD)
  })
})

const baseOrder: OrderView = {
  id: 1n,
  owner: USER,
  side: Side.BUY,
  orderType: OrderType.LIMIT,
  status: Status.EXECUTED,
  expiry: 0,
  stopActivated: false,
  base: ADDR_A,
  trailBps: 0,
  maxSlippageBps: 50,
  createdAt: 0,
  executedAt: 1,
  amountIn: 1_000_000_000n, // 1,000 USDC
  triggerPrice: 0n,
  limitPrice: 0n,
  peakPrice: 0n,
  amountOut: 500_000_000_000_000_000n, // 0.5 token (18 dec)
  executionPrice: 2000n * WAD,
}

describe('positions', () => {
  const dec = { base: (a: string) => (a.toLowerCase() === ADDR_A.toLowerCase() ? 18 : undefined), quote: 6 }

  test('average entry and unrealized PnL', () => {
    const [p] = computePositions([baseOrder], [], dec)
    expect(p.quantity).toBe(500_000_000_000_000_000n)
    expect(p.avgEntry18).toBe(2000n * WAD)
    // price rises to 3000 -> 0.5 * (3000 - 2000) = 500 USDC
    expect(unrealizedQuote(p, 3000n * WAD, 18, 6)).toBe(500_000_000n)
  })

  test('realized PnL on a partial sell', () => {
    const sell: OrderView = { ...baseOrder, id: 2n, side: Side.SELL, amountIn: 250_000_000_000_000_000n, amountOut: 600_000_000n }
    const [p] = computePositions([baseOrder, sell], [], dec)
    // sold 0.25 at cost 500 USDC -> proceeds 600 -> realized +100
    expect(p.realizedQuote).toBe(100_000_000n)
    expect(p.quantity).toBe(250_000_000_000_000_000n)
  })

  test('open or cancelled orders do not create positions; DCA fills do', () => {
    const open: OrderView = { ...baseOrder, status: Status.OPEN }
    expect(computePositions([open], [], dec)).toHaveLength(0)
    const dca: DcaView = {
      id: 1n, owner: USER, status: DcaStatus.ACTIVE, nextExecution: 0, interval: 3600, base: ADDR_A, maxSlippageBps: 50,
      executions: 2, createdAt: 0, amountPerBuy: 100_000_000n, budgetRemaining: 0n, maxPrice: 0n,
      totalSpent: 200_000_000n, totalBought: 100_000_000_000_000_000n,
    }
    const [p] = computePositions([], [dca], dec)
    expect(p.avgEntry18).toBe(2000n * WAD)
  })

  test('tokens with unknown decimals are skipped instead of guessed', () => {
    expect(computePositions([{ ...baseOrder, base: ADDR_B }], [], dec)).toHaveLength(0)
  })
})

describe('candles', () => {
  const c = (time: number, o: number, h: number, l: number, cl: number, v: number): Candle => ({ time, open: o, high: h, low: l, close: cl, volume: v })

  test('aggregates 1h candles into 4h buckets', () => {
    const hourly = [c(0, 1, 5, 1, 2, 10), c(3600, 2, 6, 2, 3, 10), c(7200, 3, 4, 0.5, 1, 10), c(10800, 1, 2, 1, 2, 10), c(14400, 2, 3, 2, 3, 5)]
    const out = aggregateCandles(hourly, 14400)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ time: 0, open: 1, high: 6, low: 0.5, close: 2, volume: 40 })
    expect(out[1].time).toBe(14400)
  })

  test('moving averages', () => {
    const cs = [1, 2, 3, 4, 5].map((v, i) => c(i * 60, v, v, v, v, 1))
    expect(sma(cs, 3).map((p) => p.value)).toEqual([2, 3, 4])
    expect(ema(cs, 3)).toHaveLength(3)
  })
})

describe('0x adapter', () => {
  test('no liquidity means no quote, never a fabricated one', () => {
    expect(parseRawQuote({ liquidityAvailable: false })).toBeNull()
  })

  test('parses a firm quote', () => {
    const q = parseRawQuote({
      liquidityAvailable: true,
      buyAmount: '100',
      minBuyAmount: '99',
      sellAmount: '50',
      route: [{ from: 'a', to: 'b', source: 'Uniswap_V3', proportionBps: '10000' }],
      totalNetworkFee: '123',
      issues: { allowance: { actual: '0', spender: ADDR_B } },
      transaction: { to: ADDR_B, data: '0x1234', value: '0', gas: '210000' },
    })
    expect(q?.minBuyAmount).toBe(99n)
    expect(q?.allowanceSpender).toBe(ADDR_B)
    expect(q?.transaction?.gas).toBe(210000n)
  })

  test('server rejects unsupported chains and bad input', () => {
    const base = { sellToken: ADDR_A, buyToken: ADDR_B, sellAmount: '1000000', taker: USER }
    const ok = parseQuoteRequest(new URLSearchParams({ ...base, chainId: '5042' }))
    expect(isApiError(ok)).toBe(false)
    const testnet = parseQuoteRequest(new URLSearchParams({ ...base, chainId: '5042002' }))
    expect(isApiError(testnet) && testnet.code).toBe('CHAIN_NOT_SUPPORTED')
    expect(isApiError(parseQuoteRequest(new URLSearchParams({ ...base, chainId: '5042', sellAmount: '0' })))).toBe(true)
    expect(isApiError(parseQuoteRequest(new URLSearchParams({ ...base, chainId: '5042', taker: 'nope' })))).toBe(true)
    expect(isApiError(parseQuoteRequest(new URLSearchParams({ ...base, chainId: '5042', slippageBps: '5000' })))).toBe(true)
  })
})

import { Backoff, chunk, inShard, mapLimit, RateLimiter, TtlCache } from '../server/scale'

describe('scaling helpers', () => {
  test('TtlCache coalesces concurrent loads and expires entries', async () => {
    const cache = new TtlCache<number>(1000)
    let calls = 0
    const load = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 5))
      return 42
    }
    const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)])
    expect([a, b, calls]).toEqual([42, 42, 1])
    await cache.get('k', load)
    expect(calls).toBe(1)
    await cache.get('k', load, Date.now() + 5000)
    expect(calls).toBe(2)
  })

  test('TtlCache does not cache failures', async () => {
    const cache = new TtlCache<number>(1000)
    let n = 0
    const flaky = async () => {
      n++
      if (n === 1) throw new Error('boom')
      return 7
    }
    await expect(cache.get('k', flaky)).rejects.toThrow('boom')
    expect(await cache.get('k', flaky)).toBe(7)
  })

  test('TtlCache evicts past its cap', async () => {
    const cache = new TtlCache<number>(60_000, 3)
    for (let i = 0; i < 6; i++) await cache.get(`k${i}`, async () => i)
    expect(cache.size).toBeLessThanOrEqual(3)
  })

  test('RateLimiter blocks after the limit and resets with the window', () => {
    const rl = new RateLimiter(2, 1000)
    expect([rl.allow('a', 0), rl.allow('a', 1), rl.allow('a', 2)]).toEqual([true, true, false])
    expect(rl.allow('b', 2)).toBe(true)
    expect(rl.allow('a', 1001)).toBe(true)
    expect(rl.retryAfter('a', 1500)).toBe(1)
  })

  test('sharding assigns every id to exactly one shard', () => {
    for (const count of [1, 2, 3, 7]) {
      for (let id = 1n; id <= 50n; id++) {
        const owners = Array.from({ length: count }, (_, i) => i).filter((i) => inShard(id, i, count))
        expect(owners).toHaveLength(1)
      }
    }
  })

  test('Backoff doubles up to its cap and clears', () => {
    const b = new Backoff(1000, 4000)
    expect(b.ready('x', 0)).toBe(true)
    expect(b.fail('x', 0)).toBe(1000)
    expect(b.ready('x', 500)).toBe(false)
    expect(b.ready('x', 1000)).toBe(true)
    expect(b.fail('x', 1000)).toBe(2000)
    expect(b.fail('x', 3000)).toBe(4000)
    expect(b.fail('x', 8000)).toBe(4000)
    b.clear('x')
    expect(b.ready('x', 8001)).toBe(true)
  })

  test('chunk and mapLimit', async () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    let active = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 3))
      active--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12])
    expect(peak).toBeLessThanOrEqual(2)
  })
})

import harness from '../src/trading/testnet-harness.json'
import { getAggregator } from '../src/trading/aggregator'
import { NETWORKS } from '../src/trading/networks'

describe('testnet harness', () => {
  test('deployment record is complete and well formed', () => {
    const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a)
    expect([harness.orders, harness.router, harness.usdcFeed].every(isAddr)).toBe(true)
    expect(harness.assets.map((a) => a.symbol)).toEqual(['tBTC', 'tETH', 'tSOL'])
    for (const a of harness.assets) {
      expect(isAddr(a.address) && isAddr(a.feed)).toBe(true)
      expect(a.initialPrice).toBeGreaterThan(0)
    }
    // USDC feed + one per asset + the router target (+ the optional second router)
    expect(harness.queuedConfig).toHaveLength(harness.assets.length + 2 + ('routerB' in harness ? 1 : 0))
  })

  test('testnet lists the test assets first and flags them', () => {
    const bases = NETWORKS['arc-testnet'].bases
    expect(bases.slice(0, 3).every((b) => b.isTest && b.testFeed)).toBe(true)
    expect(bases.filter((b) => !b.isTest).map((b) => b.symbol)).toEqual(['EURC', 'cirBTC', 'WETH'])
  })

  test('testnet uses the test router, mainnet uses 0x', () => {
    expect(getAggregator(NETWORKS['arc-testnet']).id).toBe('test-router')
    expect(getAggregator(NETWORKS.arc).id).toBe('0x')
    expect(getAggregator(NETWORKS.arc).unavailableReason()).toBeNull()
  })
})
