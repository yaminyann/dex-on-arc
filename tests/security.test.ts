import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import { assertSafeSwapQuote, AggregatorError, type SwapQuote } from '../src/trading/aggregator'
import { bearerMatches, isOperator, originAllowed, parseList, redactSecrets, resolveClientIp } from '../server/security'
import { RateLimiter } from '../server/scale'

const HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734' as Address
const EVIL = '0x00000000000000000000000000000000deadbeef' as Address

function quote(over: Partial<SwapQuote> & { to?: Address; value?: bigint } = {}): SwapQuote {
  return {
    buyAmount: 1n,
    minBuyAmount: 1n,
    sellAmount: 1n,
    route: [],
    networkFeeNative: null,
    allowanceSpender: over.allowanceSpender === undefined ? HOLDER : over.allowanceSpender,
    allowanceActual: 0n,
    transaction: { to: over.to ?? HOLDER, data: '0x' as Hex, value: over.value ?? 0n, gas: null },
  }
}

describe('client address resolution', () => {
  test('ignores x-forwarded-for unless a trusted proxy is configured', () => {
    expect(resolveClientIp('1.2.3.4', '9.9.9.9', 0)).toBe('9.9.9.9')
  })

  test('spoofed prefix entries do not change the bucket behind one trusted proxy', () => {
    const a = resolveClientIp('10.0.0.1, 203.0.113.7', '127.0.0.1', 1)
    const b = resolveClientIp('10.0.0.2, 203.0.113.7', '127.0.0.1', 1)
    expect(a).toBe('203.0.113.7')
    expect(b).toBe('203.0.113.7')
  })

  test('falls back to the socket when the header is shorter than the hop count', () => {
    expect(resolveClientIp('203.0.113.7', '127.0.0.1', 2)).toBe('127.0.0.1')
    expect(resolveClientIp(null, undefined, 0)).toBe('local')
  })

  test('rotating a fake header cannot get past the per-client limit', () => {
    const limiter = new RateLimiter(3, 60_000)
    let allowed = 0
    for (let i = 0; i < 20; i++) if (limiter.allow(resolveClientIp(`10.0.0.${i}`, '198.51.100.9', 0))) allowed++
    expect(allowed).toBe(3)
  })
})

describe('origin gate', () => {
  const list = ['https://app.example.com']
  test('is off when no origins are configured', () => {
    expect(originAllowed(null, null, [])).toBe(true)
  })
  test('accepts a listed Origin or Referer, rejects others and missing headers', () => {
    expect(originAllowed('https://app.example.com', null, list)).toBe(true)
    expect(originAllowed(null, 'https://app.example.com/trade?x=1', list)).toBe(true)
    expect(originAllowed('https://evil.example', null, list)).toBe(false)
    expect(originAllowed(null, 'not a url', list)).toBe(false)
    expect(originAllowed(null, null, list)).toBe(false)
  })
  test('parseList trims and drops empties', () => {
    expect(parseList(' a, ,b ')).toEqual(['a', 'b'])
    expect(parseList(undefined)).toEqual([])
  })
})

describe('operator access', () => {
  test('bearer token must match exactly; unset token never matches', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true)
    expect(bearerMatches('Bearer wrong', 's3cret')).toBe(false)
    expect(bearerMatches('s3cret', 's3cret')).toBe(false)
    expect(bearerMatches('Bearer ', '')).toBe(false)
    expect(bearerMatches(null, 's3cret')).toBe(false)
  })
  test('without a token only a direct loopback connection is an operator', () => {
    expect(isOperator(new Headers(), '127.0.0.1', undefined)).toBe(true)
    expect(isOperator(new Headers(), '203.0.113.7', undefined)).toBe(false)
    expect(isOperator(new Headers({ 'x-forwarded-for': '203.0.113.7' }), '127.0.0.1', undefined)).toBe(false)
  })
  test('with a token, loopback alone is not enough', () => {
    expect(isOperator(new Headers(), '127.0.0.1', 'tok')).toBe(false)
    expect(isOperator(new Headers({ authorization: 'Bearer tok' }), '203.0.113.7', 'tok')).toBe(true)
  })
  test('redacts URLs and 32-byte hex from error text', () => {
    const text = `HTTP request failed. URL: https://rpc.example/api?_rpc_token=abc key 0x${'a'.repeat(64)}`
    const out = redactSecrets(text)
    expect(out).not.toContain('abc')
    expect(out).not.toContain('rpc.example')
    expect(out).not.toContain('aaaa')
  })
})

describe('swap target pinning', () => {
  test('accepts a known target and spender (case-insensitive)', () => {
    expect(() => assertSafeSwapQuote([HOLDER], quote({ to: HOLDER.toLowerCase() as Address }))).not.toThrow()
  })
  test('rejects an unknown transaction target', () => {
    expect(() => assertSafeSwapQuote([HOLDER], quote({ to: EVIL }))).toThrow(AggregatorError)
  })
  test('rejects native value', () => {
    expect(() => assertSafeSwapQuote([HOLDER], quote({ value: 1n }))).toThrow(AggregatorError)
  })
  test('rejects an unknown approval spender even on an indicative price', () => {
    const q = quote({ allowanceSpender: EVIL })
    delete q.transaction
    expect(() => assertSafeSwapQuote([HOLDER], q)).toThrow(AggregatorError)
  })
  test('a quote with no spender and no transaction passes', () => {
    const q = quote({ allowanceSpender: null })
    delete q.transaction
    expect(() => assertSafeSwapQuote([HOLDER], q)).not.toThrow()
  })
})
