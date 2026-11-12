import { ConnectKitButton } from 'connectkit'
import type { NetworkConfig } from '@/trading/networks'
import { useAccountSummary } from '@/trading/account'
import { averagePrice18, formatPrice18, formatToken, pctDiff } from '@/trading/math'
import { DcaStatus } from '@/trading/types'
import { fmtPct } from '@/trading/format'
import { Empty, Panel, Skeleton } from './ui'
import { NetworkBanner } from './NetworkBanner'
import { TokenBase } from './TokenIcon'
import { lookupToken, Table } from './OrderTables'
import { OrderTabs } from './OrderTabs'

/** Account overview: value, PnL, balances, escrow, plans and every order and fill. */
export function Dashboard({ network }: { network: NetworkConfig }) {
  const a = useAccountSummary(network)
  const q = network.quote
  const usd = (v: bigint) => `${formatToken(v, q.decimals, 2)} USDC`
  const tone = (v: bigint) => (v > 0n ? 'text-up' : v < 0n ? 'text-down' : '')

  if (!a.connected) {
    return (
      <div className="space-y-4">
        <NetworkBanner network={network} />
        <Panel className="mx-auto max-w-xl p-10 text-center">
          <h1 className="font-display text-xl font-semibold">Your dashboard</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-mute">Connect a wallet to see your balances, escrowed funds, orders, plans and PnL on {network.label}.</p>
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button onClick={show} className="mt-5 min-h-[40px] rounded-lg bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90">
                Connect wallet
              </button>
            )}
          </ConnectKitButton.Custom>
        </Panel>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <NetworkBanner network={network} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Account value" value={a.loading ? null : usd(a.total)} sub={a.unpriced ? `${a.unpriced} token(s) without a price are left out` : 'Balances plus escrow'} big />
        <Stat label="Available" value={a.loading ? null : usd(a.available)} sub="Free USDC (also your gas)" />
        <Stat label="In orders" value={a.loading ? null : usd(a.locked)} sub="Escrowed in buy orders and DCA" />
        <Stat label="Realized PnL" value={usd(a.realized)} tone={tone(a.realized)} sub="Filled orders and plans" />
        <Stat label="Unrealized PnL" value={usd(a.unrealized)} tone={tone(a.unrealized)} sub="Open positions at oracle price" />
      </div>

      <Panel>
        <div className="border-b border-line px-4 py-3 font-display text-sm font-semibold">Balances</div>
        {a.loading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <Table
            head={['Token', 'Available', 'In orders', 'Total', 'Value']}
            empty={{ title: 'No tokens', body: '' }}
            rows={a.rows.map((r) => [
              <span key="t" className="flex items-center gap-2">
                <TokenBase token={r.token} size={18} />
                {r.token.symbol}
              </span>,
              formatToken(r.available, r.token.decimals, 6),
              formatToken(r.locked, r.token.decimals, 6),
              formatToken(r.available + r.locked, r.token.decimals, 6),
              r.value !== null ? usd(r.value) : <span key="v" className="text-mute">No oracle price</span>,
            ])}
          />
        )}
      </Panel>

      {network.ordersAddress ? (
        <OrderTabs network={network} />
      ) : (
        <Panel>
          <Empty title="No order contract on this network">Orders and DCA appear here once an order contract is configured. Market swaps do not need one.</Empty>
        </Panel>
      )}

      {a.dcas.length > 0 && (
        <Panel>
          <div className="border-b border-line px-4 py-3 font-display text-sm font-semibold">DCA performance</div>
          <Table
            head={['Token', 'Status', 'Buys', 'Spent', 'Bought', 'Avg. entry', 'Oracle price', 'Vs entry']}
            empty={{ title: 'No DCA plans', body: 'Create a recurring buy from the Trade page or the Agent Station.' }}
            rows={a.dcas.map((d) => {
              const t = lookupToken(network, d.base)
              const avg = t ? averagePrice18(d.totalSpent, d.totalBought, t.decimals, q.decimals) : 0n
              const o = a.prices[d.base.toLowerCase()]
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

      <p className="text-[11px] text-mute">PnL covers fills made through the order contract. Market swaps and tokens you received elsewhere have no tracked cost basis.</p>
    </div>
  )
}

function Stat({ label, value, sub, tone, big }: { label: string; value: string | null; sub: string; tone?: string; big?: boolean }) {
  return (
    <Panel className={`p-4 ${big ? 'col-span-2 lg:col-span-1' : ''}`}>
      <div className="text-[11px] uppercase tracking-wider text-mute">{label}</div>
      {value === null ? <Skeleton className="mt-2 h-7 w-28" /> : <div className={`num mt-1 font-display text-lg font-semibold sm:text-xl ${tone ?? ''}`}>{value}</div>}
      <div className="mt-1 text-[11px] text-mute">{sub}</div>
    </Panel>
  )
}
