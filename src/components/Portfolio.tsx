import { useAccount } from 'wagmi'
import { useBalances, useDcas, useExecutionLogs, useOraclePrices, useOrders } from '@/trading/hooks'
import type { NetworkConfig } from '@/trading/networks'
import { averagePrice18, formatPrice18, formatToken, quoteForBase, pctDiff } from '@/trading/math'
import { computePositions, unrealizedQuote } from '@/trading/portfolio'
import { DcaStatus, Side, Status } from '@/trading/types'
import { fmtPct } from '@/trading/format'
import { Empty, Notice, Panel, Skeleton } from './ui'
import { TokenBase } from './TokenIcon'
import { lookupToken, Table } from './OrderTables'

export function Portfolio({ network }: { network: NetworkConfig }) {
  const { address } = useAccount()
  const tokens = [network.quote, ...network.bases]
  const balances = useBalances(network, address)
  const orders = useOrders(network, address)
  const dcas = useDcas(network, address)
  const logs = useExecutionLogs(network, address)
  const prices = useOraclePrices(network, network.bases)

  if (!address) {
    return (
      <Panel>
        <Empty title="Connect a wallet">The portfolio reads your real balances and fills from {network.label}.</Empty>
      </Panel>
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

  const positions = computePositions(orderList, dcaList, { base: (a) => lookupToken(network, a)?.decimals, quote: q.decimals })
  let realized = 0n
  let unrealized = 0n
  let spent = 0n
  for (const p of positions) {
    const t = lookupToken(network, p.base)
    realized += p.realizedQuote
    spent += p.spentQuote
    const o = prices[p.base]
    if (t && o?.status === 'ok') unrealized += unrealizedQuote(p, o.price18, t.decimals, q.decimals)
  }
  const usd = (v: bigint) => `${v < 0n ? '-' : ''}${formatToken(v < 0n ? -v : v, q.decimals, 2)} USDC`
  const tone = (v: bigint) => (v >= 0n ? 'text-up' : 'text-down')

  const loading = balances.isLoading

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total value" value={loading ? null : usd(total)} sub={unpriced ? `${unpriced} token(s) without an oracle price are excluded` : 'Balances plus escrow, at oracle prices'} />
        <Stat label="Realized PnL" value={usd(realized)} tone={tone(realized)} sub="From orders filled through the contract" />
        <Stat label="Unrealized PnL" value={usd(unrealized)} tone={tone(unrealized)} sub="Open tracked positions at oracle price" />
        <Stat label="Total spent buying" value={usd(spent)} sub="Orders and DCA fills" />
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
            rows={rows.map((r) => [
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
        <div className="px-4 pb-3 pt-1 text-[11px] text-mute">Single USDC balance shown from the ERC-20 view; on Arc it is the same pool as the gas balance.</div>
      </Panel>

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

      <Notice>
        Keeper fees paid are listed per fill on the Trade page. {logs.data?.partial ? 'Fee history may be incomplete because the RPC limited the log range.' : ''} PnL covers contract fills only.
      </Notice>
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
