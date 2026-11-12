import { useAccount } from 'wagmi'
import { tradableBases, type NetworkConfig, type TokenInfo } from './networks'
import { useTokenList } from './tokens'
import { useBalances, useDcas, useOraclePrices, useOrders } from './hooks'
import { quoteForBase } from './math'
import { computePositions, unrealizedQuote } from './portfolio'
import { DcaStatus, Side, Status, type DcaView, type OrderView } from './types'
import type { OracleState } from './hooks'

export interface BalanceRow {
  token: TokenInfo
  available: bigint
  locked: bigint
  /** Value in quote units, or null when the contract oracle cannot price the token. */
  value: bigint | null
}

export interface AccountSummary {
  connected: boolean
  loading: boolean
  rows: BalanceRow[]
  /** Quote units. Balances plus escrow, priced where an oracle exists. */
  total: bigint
  available: bigint
  locked: bigint
  realized: bigint
  unrealized: bigint
  unpriced: number
  orders: OrderView[]
  dcas: DcaView[]
  prices: Record<string, OracleState | undefined>
}

/** One place that turns balances, escrow and fills into the numbers the account panel and dashboard show. */
export function useAccountSummary(network: NetworkConfig): AccountSummary {
  const { address } = useAccount()
  const listed = useTokenList(network).tokens
  const tradable = tradableBases(network).map((t) => t.address.toLowerCase())
  const tokens = [network.quote, ...network.bases, ...listed.filter((t) => !network.bases.some((b) => b.address === t.address))]
  const balances = useBalances(network, address)
  const orders = useOrders(network, address)
  const dcas = useDcas(network, address)
  // Oracle prices only exist for tokens configured on the order contract.
  const prices = useOraclePrices(network, network.bases)

  const q = network.quote
  const orderList = orders.data ?? []
  const dcaList = dcas.data ?? []

  const locked: Record<string, bigint> = {}
  const addLock = (addr: string, v: bigint) => (locked[addr.toLowerCase()] = (locked[addr.toLowerCase()] ?? 0n) + v)
  for (const o of orderList) if (o.status === Status.OPEN) addLock(o.side === Side.BUY ? q.address : o.base, o.amountIn)
  for (const d of dcaList) if (d.status === DcaStatus.ACTIVE || d.status === DcaStatus.PAUSED) addLock(q.address, d.budgetRemaining)

  let total = 0n
  let unpriced = 0
  const all: BalanceRow[] = tokens.map((token) => {
    const key = token.address.toLowerCase()
    const available = balances.data?.[key] ?? 0n
    const lock = locked[key] ?? 0n
    const sum = available + lock
    let value: bigint | null = null
    if (token.address === q.address) value = sum
    else {
      const o = prices[key]
      if (o?.status === 'ok') value = quoteForBase(sum, o.price18, token.decimals, q.decimals)
    }
    if (value !== null) total += value
    else if (sum > 0n) unpriced++
    return { token, available, locked: lock, value }
  })
  // Only USDC, tradable tokens and anything actually held. Empty rows for untradable tokens are noise.
  const rows = all.filter((r) => r.token.address === q.address || tradable.includes(r.token.address.toLowerCase()) || r.available + r.locked > 0n)

  const lookup = (a: string) => [q, ...network.bases].find((t) => t.address.toLowerCase() === a.toLowerCase())
  const positions = computePositions(orderList, dcaList, { base: (a) => lookup(a)?.decimals, quote: q.decimals })
  let realized = 0n
  let unrealized = 0n
  for (const p of positions) {
    const t = lookup(p.base)
    realized += p.realizedQuote
    const o = prices[p.base]
    if (t && o?.status === 'ok') unrealized += unrealizedQuote(p, o.price18, t.decimals, q.decimals)
  }

  return {
    connected: Boolean(address),
    loading: Boolean(address) && balances.isLoading,
    rows,
    total,
    available: balances.data?.[q.address.toLowerCase()] ?? 0n,
    locked: locked[q.address.toLowerCase()] ?? 0n,
    realized,
    unrealized,
    unpriced,
    orders: orderList,
    dcas: dcaList,
    prices,
  }
}
