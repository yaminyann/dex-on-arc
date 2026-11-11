/**
 * Positions and PnL derived ONLY from fills that happened through the order contract
 * (executed orders and DCA plans). Market swaps made directly in a wallet are not included.
 */
import type { DcaView, OrderView } from './types'
import { Side, Status } from './types'
import { WAD } from './math'

export interface Position {
  base: string
  /** Base units currently held from tracked fills. */
  quantity: bigint
  /** Base units bought and the quote spent buying them. */
  bought: bigint
  spentQuote: bigint
  /** Base units sold and the quote received. */
  sold: bigint
  receivedQuote: bigint
  /** Average entry price, 1e18 scaled (quote per whole base). 0 when nothing was bought. */
  avgEntry18: bigint
  /** Realized PnL in quote units: proceeds minus average cost of what was sold. */
  realizedQuote: bigint
}

export interface DecimalsLookup {
  base: (addr: string) => number | undefined
  quote: number
}

export function computePositions(orders: OrderView[], dcas: DcaView[], dec: DecimalsLookup): Position[] {
  const map = new Map<string, Position>()
  const get = (base: string): Position => {
    const key = base.toLowerCase()
    let p = map.get(key)
    if (!p) {
      p = { base: key, quantity: 0n, bought: 0n, spentQuote: 0n, sold: 0n, receivedQuote: 0n, avgEntry18: 0n, realizedQuote: 0n }
      map.set(key, p)
    }
    return p
  }

  for (const o of orders) {
    if (o.status !== Status.EXECUTED) continue
    const p = get(o.base)
    if (o.side === Side.BUY) {
      p.spentQuote += o.amountIn
      p.bought += o.amountOut
    } else {
      p.sold += o.amountIn
      p.receivedQuote += o.amountOut
    }
  }
  for (const d of dcas) {
    if (d.totalBought === 0n) continue
    const p = get(d.base)
    p.spentQuote += d.totalSpent
    p.bought += d.totalBought
  }

  const out: Position[] = []
  for (const p of map.values()) {
    const bd = dec.base(p.base)
    if (bd === undefined) continue
    p.quantity = p.bought - p.sold
    if (p.bought > 0n) {
      p.avgEntry18 = (p.spentQuote * WAD * 10n ** BigInt(bd)) / (p.bought * 10n ** BigInt(dec.quote))
      const costOfSold = (p.sold * p.spentQuote) / p.bought
      p.realizedQuote = p.receivedQuote - costOfSold
    } else {
      p.realizedQuote = p.receivedQuote
    }
    out.push(p)
  }
  return out
}

/** Unrealized PnL (quote units) for the remaining quantity at `price18`. */
export function unrealizedQuote(p: Position, price18: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  if (p.quantity <= 0n || p.bought === 0n) return 0n
  const value = (p.quantity * price18 * 10n ** BigInt(quoteDecimals)) / (WAD * 10n ** BigInt(baseDecimals))
  const cost = (p.quantity * p.spentQuote) / p.bought
  return value - cost
}
