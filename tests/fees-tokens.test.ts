import { describe, expect, test } from 'bun:test'
import { feeAmount, MAX_PLATFORM_FEE_BPS, parsePlatformFee } from '../server/gateway/fee'
import { cleanText, createTokenList, normalizeTokens } from '../server/gateway/tokens'
import { createKyberProvider } from '../server/gateway/kyber'

const RECIPIENT = '0x43aBbA38cCfbfa7D0044104681542347dfCB34F7'
const USDC = '0x3600000000000000000000000000000000000000'
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
const TAKER = '0x0000000000000000000000000000000000000001'

describe('platform fee settings', () => {
  test('off by default and when zero', () => {
    expect(parsePlatformFee({}).fee).toBeNull()
    expect(parsePlatformFee({ PLATFORM_FEE_BPS: '0' }).fee).toBeNull()
    expect(parsePlatformFee({ PLATFORM_FEE_BPS: '' }).problem).toBeUndefined()
  })

  test('a valid fee needs a recipient', () => {
    expect(parsePlatformFee({ PLATFORM_FEE_BPS: '30', PLATFORM_FEE_RECIPIENT: RECIPIENT }).fee).toEqual({ bps: 30, recipient: RECIPIENT })
    const noRecipient = parsePlatformFee({ PLATFORM_FEE_BPS: '30' })
    expect(noRecipient.fee).toBeNull()
    expect(noRecipient.problem).toContain('PLATFORM_FEE_RECIPIENT')
    expect(parsePlatformFee({ PLATFORM_FEE_BPS: '30', PLATFORM_FEE_RECIPIENT: '0x0000000000000000000000000000000000000000' }).fee).toBeNull()
    expect(parsePlatformFee({ PLATFORM_FEE_BPS: '30', PLATFORM_FEE_RECIPIENT: 'nope' }).fee).toBeNull()
  })

  test('the fee is capped and bad values turn it off instead of on', () => {
    expect(parsePlatformFee({ PLATFORM_FEE_BPS: String(MAX_PLATFORM_FEE_BPS), PLATFORM_FEE_RECIPIENT: RECIPIENT }).fee?.bps).toBe(MAX_PLATFORM_FEE_BPS)
    for (const bad of ['101', '-5', '0.5', 'abc', '1e3']) {
      const r = parsePlatformFee({ PLATFORM_FEE_BPS: bad, PLATFORM_FEE_RECIPIENT: RECIPIENT })
      expect(r.fee).toBeNull()
      expect(r.problem).toBeDefined()
    }
  })

  test('fee amount rounds down', () => {
    expect(feeAmount(10_000_000n, 30)).toBe(30_000n)
    expect(feeAmount(999n, 30)).toBe(2n)
    expect(feeAmount(1n, 30)).toBe(0n)
  })
})

describe('kyber platform fee', () => {
  const ROUTE = { code: 0, data: { routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', routeSummary: { amountIn: '1000000', amountOut: '900000', gas: '1', gasPrice: '1', route: [] } } }

  function recorder(urls: string[]) {
    return async (input: string) => {
      urls.push(input)
      return new Response(JSON.stringify(ROUTE), { status: 200 })
    }
  }
  const req = { chainId: 5042, sellToken: USDC, buyToken: EURC, sellAmount: '1000000', taker: TAKER, slippageBps: 50 }

  test('adds the fee parameters and reports the fee on the quote', async () => {
    const urls: string[] = []
    const p = createKyberProvider({ fetchFn: recorder(urls) })
    const res = await p.fetch('price', { ...req, fee: { bps: 30, recipient: RECIPIENT } }, new AbortController().signal)
    if (res.kind !== 'quote') throw new Error('expected quote')
    const qs = new URL(urls[0]).searchParams
    expect(qs.get('feeAmount')).toBe('30')
    expect(qs.get('chargeFeeBy')).toBe('currency_in')
    expect(qs.get('isInBps')).toBe('true')
    expect(qs.get('feeReceiver')).toBe(RECIPIENT)
    expect(res.quote.platformFee).toEqual({ bps: 30, recipient: RECIPIENT, amount: 3_000n })
  })

  test('requests without a fee carry no fee parameters (keepers)', async () => {
    const urls: string[] = []
    const p = createKyberProvider({ fetchFn: recorder(urls) })
    const res = await p.fetch('price', req, new AbortController().signal)
    if (res.kind !== 'quote') throw new Error('expected quote')
    expect(new URL(urls[0]).searchParams.has('feeAmount')).toBe(false)
    expect(res.quote.platformFee).toBeUndefined()
  })
})

describe('token list', () => {
  const good = { address: '0xBEF5F6D51CB62B58E6A8F77868681825C6FE21C1', symbol: 'EURC', name: 'EURC', decimals: 6, isWhitelisted: true, marketCap: 5, logoURI: 'https://x.test/a.png' }

  test('keeps only whitelisted, safe, well-formed tokens', () => {
    const out = normalizeTokens([
      good,
      { ...good, address: '0x1111111111111111111111111111111111111111', symbol: 'HP', isHoneypot: true },
      { ...good, address: '0x2222222222222222222222222222222222222222', symbol: 'FOT', isFOT: true },
      { ...good, address: '0x3333333333333333333333333333333333333333', symbol: 'NOWL', isWhitelisted: false },
      { ...good, address: 'not-an-address', symbol: 'BAD' },
      { ...good, address: '0x4444444444444444444444444444444444444444', symbol: 'DEC', decimals: 99 },
      { ...good, address: '0x5555555555555555555555555555555555555555', symbol: '' },
      null,
      42,
    ])
    expect(out.map((t) => t.symbol)).toEqual(['EURC'])
    expect(out[0].address).toBe('0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1')
  })

  test('sanitises text, drops non-https logos, removes duplicates and sorts by market cap', () => {
    const out = normalizeTokens([
      { ...good, address: '0x6666666666666666666666666666666666666666', symbol: 'A<script>', name: 'x'.repeat(100), marketCap: 1, logoURI: 'http://insecure.test/a.png' },
      good,
      good,
    ])
    expect(out).toHaveLength(2)
    expect(out[0].symbol).toBe('EURC')
    expect(out[1].symbol).toBe('Ascript')
    expect(out[1].name.length).toBe(40)
    expect(out[1].logoURI).toBeUndefined()
    expect(cleanText('a\u0000b\u001fc', 10)).toBe('abc')
  })

  test('caches, coalesces concurrent loads, and serves the last good list when the registry fails', async () => {
    let calls = 0
    let fail = false
    let clock = 0
    const list = createTokenList({
      ttlMs: 1000,
      now: () => clock,
      fetchFn: async () => {
        calls++
        if (fail) return new Response('{}', { status: 500 })
        return new Response(JSON.stringify({ data: { tokens: [good], pagination: { totalItems: 1 } } }), { status: 200 })
      },
    })
    const [a, b] = await Promise.all([list.get(5042), list.get(5042)])
    expect(a).toEqual(b)
    expect(calls).toBe(1)
    await list.get(5042)
    expect(calls).toBe(1)
    clock = 5000
    fail = true
    expect((await list.get(5042)).map((t) => t.symbol)).toEqual(['EURC'])
    expect(calls).toBe(2)
  })

  test('unsupported chains return an empty list without calling the registry', async () => {
    let calls = 0
    const list = createTokenList({ fetchFn: async () => (calls++, new Response('{}')) })
    expect(await list.get(5042002)).toEqual([])
    expect(calls).toBe(0)
  })

  test('fails when there is no cached list and the registry is down', async () => {
    const list = createTokenList({ fetchFn: async () => new Response('{}', { status: 503 }) })
    await expect(list.get(5042)).rejects.toThrow()
  })
})
