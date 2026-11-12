/**
 * Platform fee on market swaps. It is charged by the aggregator itself (KyberSwap `feeAmount`, 0x
 * `swapFeeBps`) and paid straight to PLATFORM_FEE_RECIPIENT inside the same swap transaction, so this
 * server never holds user funds and the fee is already deducted from the quote the user sees.
 *
 * It applies only to market swaps requested by the browser. Orders executed by keepers are not charged
 * here: their platform revenue is the contract's keeper fee, which is paid to whoever submits the
 * execution (run your own keeper to earn it).
 */
export interface PlatformFee {
  /** Basis points of the sell amount. 1 to MAX_PLATFORM_FEE_BPS. */
  bps: number
  recipient: string
}

export const MAX_PLATFORM_FEE_BPS = 100

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'

export interface PlatformFeeConfig {
  fee: PlatformFee | null
  /** Why the fee is off even though PLATFORM_FEE_BPS was set. Shown to the operator. */
  problem?: string
}

/** Reads PLATFORM_FEE_BPS and PLATFORM_FEE_RECIPIENT. An invalid setting turns the fee off, never on. */
export function parsePlatformFee(env: Record<string, string | undefined> = process.env): PlatformFeeConfig {
  const raw = (env.PLATFORM_FEE_BPS ?? '').trim()
  if (raw === '' || raw === '0') return { fee: null }
  const bps = Number(raw)
  if (!Number.isInteger(bps) || bps < 1 || bps > MAX_PLATFORM_FEE_BPS) {
    return { fee: null, problem: `PLATFORM_FEE_BPS must be a whole number from 0 to ${MAX_PLATFORM_FEE_BPS}. The fee is off.` }
  }
  const recipient = (env.PLATFORM_FEE_RECIPIENT ?? '').trim()
  if (!ADDRESS_RE.test(recipient) || recipient.toLowerCase() === ZERO) {
    return { fee: null, problem: 'PLATFORM_FEE_RECIPIENT must be a non-zero address when PLATFORM_FEE_BPS is set. The fee is off.' }
  }
  return { fee: { bps, recipient } }
}

/** Fee amount in sell-token base units, rounded down like the aggregator. */
export function feeAmount(sellAmount: bigint, bps: number): bigint {
  return (sellAmount * BigInt(bps)) / 10_000n
}
