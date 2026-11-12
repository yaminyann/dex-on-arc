import { useAccount } from 'wagmi'
import { tradableBases } from '@/trading/networks'
import { useTokenList } from '@/trading/tokens'
import { useBalances, useDcas, useExecutionLogs, useOraclePrices, useOrders } from '@/trading/hooks'
import type { NetworkConfig } from '@/trading/networks'
import { averagePrice18, formatPrice18, formatToken, quoteForBase, pctDiff } from '@/trading/math'
import { computePositions, unrealizedQuote } from '@/trading/portfolio'
import { DcaStatus, Side, Status } from '@/trading/types'
import { fmtPct } from '@/trading/format'
import { Empty, Panel, Skeleton } from './ui'
import { NetworkBanner } from './NetworkBanner'
import { TokenBase } from './TokenIcon'
import { lookupToken, Table } from './OrderTables'

export function Portfolio({ network }: { network: NetworkConfig }) {
  const { address } = useAccount()
  const listed = useTokenList(network).tokens
  const tradable = tradableBases(network).map((t) => t.address.toLowerCase())
  const tokens = [network.quote, ...network.bases, ...listed.filter((t) => !network.bases.some((b) => b.address === t.address))]
  const balances = useBalances(network, address)
  const orders = useOrders(network, address)
  const dcas = useDcas(network, address)
  const logs = useExecutionLogs(network, address)
  // Oracle prices only exist for tokens configured on the order contract.
  const prices = useOraclePrices(network, network.bases)

  if (!address) {
    return (
      <div className="space-y-4">
        <NetworkBanner network={network} />
        <Panel>
          <Empty title="Connect a wallet">Your balances, escrowed funds and PnL on {network.label} appear here.</Empty>
        </Panel>
      </div>
    )
  }

  const orderList = orders.data ?? []
  const dcaList = dcas.data ?? []
  const q = network.quote

  // Locked = escrow inside open orders and DCA budgets.
  const locked: Record<string, bigint> = {}
  const addLock = (addr: string, v: bigint) => (locked[addr.toLowerCase()] = (locked[addr.toLowerCase()] ?? 0n) + v)
  for (const o of orderList) if (o.status === Status.OPEN) addLock(o.side === Side.BUY ? q.address : o.base, o.amountIn)
  for (const d of dcaList) if (d.status === DcaStatus.ACTIVE || d.status === DcaStatus.PAUSED) addLock(q.address, d.budgetRemaining)

  // Value in USDC: quote is 1:1; bases only when the contract oracle can price them.
  let total = 0n
  let unpriced = 0
  const rows = tokens.map((t) => {
    const key = t.address.toLowerCase()
    const avail = balances.data?.[key] ?? 0n
    const lock = locked[key] ?? 0n
    const all = avail + lock
    let value: bigint | null = null
    if (t.address === q.address) value = all
    else {
      const o = prices[key]
      if (o?.status === 'ok') value = quoteForBase(all, o.price18, t.decimals, q.decimals)
    }
    if (value !== null) total += value
    else if (all > 0n) unpriced++
    return { t, avail, lock, value }
  })
  // Only USDC, tradable tokens and anything you actually hold. Empty rows for untradable tokens are noise.
  const shown = rows.filter((r) => r.t.address === q.address || tradable.includes(r.t.address.toLowerCase()) || r.avail + r.lock > 0n)

  const positions = computePositions(orderList, dcaList, { base: (a) => lookupToken(network, a)?.decimals, quote: q.decimals })
  let realized = 0n
  let unrealized = 0n
  for (const p of positions) {
    const t = lookupToken(network, p.base)
    realized += p.realizedQuote
    const o = prices[p.base]
    if (t && o?.status === 'ok') unrealized += unrealizedQuote(p, o.price18, t.decimals, q.decimals)
  }
  const usd = (v: bigint) => `${formatToken(v, q.decimals, 2)} USDC`
  const tone = (v: bigint) => (v >= 0n ? 'text-up' : 'text-down')

  const loading = balances.isLoading

  return (
    <div className="space-y-4">
      <NetworkBanner network={network} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total value" value={loading ? null : usd(total)} sub={unpriced ? `${unpriced} token(s) without an oracle price are excluded` : 'Balances plus escrow, at oracle prices'} />
        <Stat label="Realized PnL" value={usd(realized)} tone={tone(realized)} sub="From orders filled through the contract" />
        <Stat label="Unrealized PnL" value={usd(unrealized)} tone={tone(unrealized)} sub="Open tracked positions at oracle price" />
      </div>

      <Panel>
        <div className="border-b border-line px-4 py-3 font-display text-sm font-semibold">Balances</div>
        {loading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <Table
            head={['Token', 'Available', 'Locked in orders', 'Total', 'Value']}
            empty={{ title: 'No tokens', body: '' }}
            rows={shown.map((r) => [
              <span key="t" className="flex items-center gap-2">
                <TokenBase token={r.t} size={18} />
                {r.t.symbol}
              </span>,
              formatToken(r.avail, r.t.decimals, 6),
              formatToken(r.lock, r.t.decimals, 6),
              formatToken(r.avail + r.lock, r.t.decimals, 6),
              r.value !== null ? usd(r.value) : <span key="v" className="text-mute">No oracle price</span>,
            ])}
          />
        )}
        <div className="px-4 pb-3 pt-1 text-[11px] text-mute">USDC is also your gas balance on Arc, so there is only one USDC pool.</div>
      </Panel>

      {dcaList.length > 0 && (
        <Panel>
          <div className="border-b border-line px-4 py-3 font-display text-sm font-semibold">DCA performance</div>
          <Table
            head={['Token', 'Status', 'Buys', 'Spent', 'Bought', 'Avg. entry', 'Oracle price', 'Vs entry']}
            empty={{ title: 'No DCA plans', body: 'Create a recurring buy from the Trade page.' }}
            rows={dcaList.map((d) => {
              const t = lookupToken(network, d.base)
              const avg = t ? averagePrice18(d.totalSpent, d.totalBought, t.decimals, q.decimals) : 0n
              const o = prices[d.base.toLowerCase()]
              const now = o?.status === 'ok' ? o.price18 : null
              const diff = now !== null && avg > 0n ? pctDiff(now, avg) : null
              return [
                t?.symbol ?? '-',
                d.status === DcaStatus.ACTIVE ? 'Active' : d.status === DcaStatus.PAUSED ? 'Paused' : d.status === DcaStatus.COMPLETED ? 'Completed' : 'Cancelled',
                d.executions,
                usd(d.totalSpent),
                t ? `${formatToken(d.totalBought, t.decimals, 6)} ${t.symbol}` : '-',
                avg > 0n ? formatPrice18(avg) : '-',
                now !== null ? formatPrice18(now) : '-',
                diff !== null ? <span key="d" className={diff >= 0 ? 'text-up' : 'text-down'}>{fmtPct(diff)}</span> : '-',
              ]
            })}
          />
        </Panel>
      )}

      <p className="text-[11px] text-mute">
        PnL covers fills made through the order contract. Keeper fees are listed per fill under Trades on the Trade page.{logs.data?.partial ? ' Fee history may be incomplete because the RPC limited the log range.' : ''}
      </p>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string | null; sub: string; tone?: string }) {
  return (
    <Panel className="p-4">
      <div className="text-[11px] uppercase tracking-wider text-mute">{label}</div>
      {value === null ? <Skeleton className="mt-2 h-7 w-32" /> : <div className={`num mt-1 font-display text-xl font-semibold ${tone ?? ''}`}>{value}</div>}
      <div className="mt-1 text-[11px] text-mute">{sub}</div>
    </Panel>
  )
}
