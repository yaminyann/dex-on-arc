/**
 * Pure order math shared by the forms and the tests. Prices are "quote per whole base"
 * scaled by 1e18, exactly like the contract. All amounts are base units (bigint).
 */
import { parseUnitsExact, formatUnitsFixed, formatUnitsExact } from '@/onchain-money'

export const WAD = 10n ** 18n
export const BPS = 10_000n

/** Quote units received for selling `baseAmount` base units at `price18`. Rounds down. */
export function quoteForBase(baseAmount: bigint, price18: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  return (baseAmount * price18 * 10n ** BigInt(quoteDecimals)) / (WAD * 10n ** BigInt(baseDecimals))
}

/** Base units received for spending `quoteAmount` quote units at `price18`. Rounds down. */
export function baseForQuote(quoteAmount: bigint, price18: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  if (price18 === 0n) return 0n
  return (quoteAmount * WAD * 10n ** BigInt(baseDecimals)) / (price18 * 10n ** BigInt(quoteDecimals))
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * (BPS - BigInt(slippageBps))) / BPS
}

/** Parses a decimal price string such as "62500.25" into a 1e18-scaled price. Returns null when invalid. */
export function parsePrice18(input: string): bigint | null {
  const trimmed = input.trim()
  if (!/^\d*\.?\d+$|^\d+\.?$/.test(trimmed)) return null
  try {
    const v = parseUnitsExact(trimmed, 18)
    return v > 0n ? v : null
  } catch {
    return null
  }
}

/** Parses an amount string in a token's base units. Returns null when invalid or zero. */
export function parseTokenAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim()
  if (!/^\d*\.?\d+$|^\d+\.?$/.test(trimmed)) return null
  try {
    const v = parseUnitsExact(trimmed, decimals)
    return v > 0n ? v : null
  } catch {
    return null
  }
}

export function formatToken(raw: bigint, decimals: number, maxFraction = 4): string {
  const fixed = formatUnitsFixed(raw, decimals, Math.min(maxFraction, decimals))
  const [whole, frac = ''] = fixed.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const trimmed = frac.replace(/0+$/, '')
  return trimmed ? `${grouped}.${trimmed}` : grouped
}

export function formatPrice18(price18: bigint, fraction = 2): string {
  return formatToken(price18, 18, price18 < 10n * WAD ? Math.max(fraction, 4) : fraction)
}

/** Raw decimal string suitable to prefill an input. */
export function toInputString(raw: bigint, decimals: number): string {
  return formatUnitsExact(raw, decimals)
}

/** Percent difference of a vs b, e.g. 0.012 = +1.2%. */
export function pctDiff(a: bigint, b: bigint): number {
  if (b === 0n) return 0
  return Number(((a - b) * 1_000_000n) / b) / 1_000_000
}

export const FREQ_SECONDS = { hourly: 3600, daily: 86400, weekly: 604800, monthly: 2592000 } as const

/** Number of buys that fit into a duration at a frequency (at least 1). */
export function buysForDuration(durationDays: number, intervalSeconds: number): number {
  return Math.max(1, Math.floor((durationDays * 86400) / intervalSeconds))
}

export function averagePrice18(spentQuote: bigint, boughtBase: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  if (boughtBase === 0n) return 0n
  return (spentQuote * WAD * 10n ** BigInt(baseDecimals)) / (boughtBase * 10n ** BigInt(quoteDecimals))
}
