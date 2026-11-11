/**
 * Pure keeper building blocks (no network access), kept separate so they can be unit tested:
 * nonce allocation, profitability, gas-price floor, standby gating and key loading.
 */
import fs from 'node:fs'

/** Hands out consecutive nonces within one tick, re-synced from the chain's pending count each tick. */
export class NonceTracker {
  private n: number

  constructor(start: number) {
    this.n = start
  }

  next(): number {
    return this.n++
  }

  get peek(): number {
    return this.n
  }
}

const NATIVE_PER_USDC_UNIT = 10n ** 12n

/** Gas cost in 6-decimal USDC units, rounded up (Arc's gas token is USDC, native view has 18 decimals). */
export function gasCostUsdc6(gasUnits: bigint, gasPriceWei: bigint): bigint {
  const wei = gasUnits * gasPriceWei
  return (wei + NATIVE_PER_USDC_UNIT - 1n) / NATIVE_PER_USDC_UNIT
}

/**
 * Keeper fee a quote would earn, in 6-decimal USDC units. Sell orders (output is the quote token)
 * pay the fee on the output. Buy-side and DCA orders pay it in the base token, so the quote-token
 * value of the fee is approximated by the input amount, which the base output is worth at the swap price.
 */
export function expectedFeeUsdc6(args: { outputIsQuoteToken: boolean; buyAmount: bigint; sellAmount: bigint; feeBps: number }): bigint {
  const gross = args.outputIsQuoteToken ? args.buyAmount : args.sellAmount
  return (gross * BigInt(args.feeBps)) / 10_000n
}

export interface ProfitPolicy {
  /** Require the fee to cover gas. When false every executable item is attempted. */
  require: boolean
  /** Extra safety margin over break-even, in bps of gas cost. */
  marginBps: number
  /** Absolute fee floor in 6-decimal USDC units. */
  minFeeUsdc6: bigint
}

export function isProfitable(policy: ProfitPolicy, feeUsdc6: bigint, gasUnits: bigint, gasPriceWei: bigint): boolean {
  if (!policy.require) return true
  if (feeUsdc6 < policy.minFeeUsdc6) return false
  const cost = gasCostUsdc6(gasUnits, gasPriceWei)
  return feeUsdc6 * 10_000n >= cost * BigInt(10_000 + policy.marginBps)
}

/** Arc drops transactions priced under its base-fee floor without any error, so never go below it. */
export function applyGasFloor(est: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } | undefined, floorWei: bigint): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const maxFee = est?.maxFeePerGas !== undefined && est.maxFeePerGas > floorWei ? est.maxFeePerGas : floorWei
  const tip = est?.maxPriorityFeePerGas ?? 0n
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip > maxFee ? maxFee : tip }
}

/**
 * Stateless failover. A standby keeper watches everything but acts on an item only after it has
 * stayed actionable for `graceMs`. While the primary is healthy it acts first and the item
 * disappears; if the primary dies, the standby takes over after the grace period. No shared store
 * or leader election is needed because every contract call is permissionless and idempotent.
 */
export class StandbyGate {
  private firstSeen = new Map<string, number>()

  constructor(private graceMs: number) {}

  /** Returns the keys that have been actionable long enough. Keys not in `current` are forgotten. */
  observe(current: readonly string[], now: number): Set<string> {
    const keep = new Set(current)
    for (const k of this.firstSeen.keys()) if (!keep.has(k)) this.firstSeen.delete(k)
    const ready = new Set<string>()
    for (const k of current) {
      const first = this.firstSeen.get(k) ?? now
      this.firstSeen.set(k, first)
      if (now - first >= this.graceMs) ready.add(k)
    }
    return ready
  }

  get waiting(): number {
    return this.firstSeen.size
  }
}

/**
 * Loads the keeper key. KEEPER_PRIVATE_KEY_FILE (for example a Docker or Kubernetes secret mount)
 * wins over KEEPER_PRIVATE_KEY so the key never has to sit in the process environment.
 */
export function loadKeeperKey(env: Record<string, string | undefined> = process.env, read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): { key?: `0x${string}`; error?: string } {
  let raw = env.KEEPER_PRIVATE_KEY
  const file = env.KEEPER_PRIVATE_KEY_FILE
  if (file) {
    try {
      raw = read(file)
    } catch {
      return { error: 'KEEPER_PRIVATE_KEY_FILE could not be read.' }
    }
  }
  const key = raw?.trim()
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return { error: 'Keeper private key is missing or malformed.' }
  return { key: key as `0x${string}` }
}
