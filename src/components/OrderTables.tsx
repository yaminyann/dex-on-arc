import { useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { buildTxExplorerUrl } from '@/onchain-facts'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import { formatPrice18, formatToken, averagePrice18 } from '@/trading/math'
import { fmtDateTime, fmtDuration } from '@/trading/format'
import { DCA_REASON, DCA_STATUS_LABEL, DcaStatus, ORDER_REASON, ORDER_TYPE_LABEL, Side, STATUS_LABEL, Status, type DcaView, type OrderView } from '@/trading/types'
import { useNowSeconds, type ExecutionLog } from '@/trading/hooks'
import { Badge, Button, Empty } from './ui'

const PAGE_SIZE = 25

/** Paginated table: large accounts render 25 rows at a time instead of every order at once. */
export function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: { title: string; body: string } }) {
  const [page, setPage] = useState(0)
  if (rows.length === 0) return <Empty title={empty.title}>{empty.body}</Empty>
  const pages = Math.ceil(rows.length / PAGE_SIZE)
  const current = Math.min(page, pages - 1)
  const visible = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  return (
    <div>
      <div className="thin-scroll overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead>
            <tr className="border-b border-line text-mute">
              {head.map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={current * PAGE_SIZE + i} className="border-b border-line/60 last:border-0 hover:bg-raised/40">
                {r.map((c, j) => (
                  <td key={j} className="num whitespace-nowrap px-3 py-2.5">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-mute">
          <span className="num">
            {current * PAGE_SIZE + 1}-{Math.min(rows.length, (current + 1) * PAGE_SIZE)} of {rows.length}
          </span>
          <div className="flex gap-1.5">
            <Button variant="ghost" className="min-h-[30px] px-2 text-xs" disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </Button>
            <Button variant="ghost" className="min-h-[30px] px-2 text-xs" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function lookupToken(network: NetworkConfig, addr: string): TokenInfo | undefined {
  return [network.quote, ...network.bases].find((t) => t.address.toLowerCase() === addr.toLowerCase())
}

export function TxLink({ chainId, hash }: { chainId: number; hash?: string }) {
  if (!hash) return <span className="text-mute">-</span>
  return (
    <a href={buildTxExplorerUrl(chainId, hash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
      {hash.slice(0, 8)}
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}

function statusBadge(status: number) {
  const tone = status === Status.EXECUTED ? 'up' : status === Status.OPEN ? 'accent' : status === Status.EXPIRED ? 'warn' : 'mute'
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>
}

function pair(network: NetworkConfig, o: { base: string }) {
  return `${lookupToken(network, o.base)?.symbol ?? 'Token'}/${network.quote.symbol}`
}

function triggerText(o: OrderView): string {
  if (o.orderType === 4) return `Trail ${(o.trailBps / 100).toFixed(2)}% (peak ${formatPrice18(o.peakPrice)})`
  if (o.orderType === 5) return `Stop ${formatPrice18(o.triggerPrice)} / TP ${formatPrice18(o.limitPrice)}`
  if (o.orderType === 3) return `Stop ${formatPrice18(o.triggerPrice)} / Limit ${formatPrice18(o.limitPrice)}${o.stopActivated ? ' (active)' : ''}`
  return formatPrice18(o.triggerPrice)
}

function amountText(network: NetworkConfig, o: OrderView): string {
  const t = o.side === Side.BUY ? network.quote : lookupToken(network, o.base)
  return t ? `${formatToken(o.amountIn, t.decimals, 6)} ${t.symbol}` : o.amountIn.toString()
}

function outText(network: NetworkConfig, o: OrderView): string {
  const t = o.side === Side.BUY ? lookupToken(network, o.base) : network.quote
  return t && o.amountOut > 0n ? `${formatToken(o.amountOut, t.decimals, 6)} ${t.symbol}` : '-'
}

const sideCell = (o: OrderView) => <span className={o.side === Side.BUY ? 'text-up' : 'text-down'}>{o.side === Side.BUY ? 'Buy' : 'Sell'}</span>

export function OpenOrdersTable({
  network,
  orders,
  onCancel,
  onExpire,
  busy,
}: {
  network: NetworkConfig
  orders: OrderView[]
  onCancel: (id: bigint) => void
  onExpire: (id: bigint) => void
  busy: boolean
}) {
  const now = useNowSeconds()
  return (
    <Table
      head={['Pair', 'Type', 'Side', 'Trigger', 'Amount', 'Status', 'Created', 'Expires', '']}
      empty={{ title: 'No open orders', body: 'Escrowed orders waiting for their trigger appear here.' }}
      rows={orders.map((o) => {
        const expired = now >= o.expiry
        return [
          pair(network, o),
          ORDER_TYPE_LABEL[o.orderType],
          sideCell(o),
          triggerText(o),
          amountText(network, o),
          <Badge key="s" tone={o.reasonCode === 0 ? 'up' : 'mute'}>
            {expired ? 'Expired' : ORDER_REASON[o.reasonCode ?? 3]}
          </Badge>,
          fmtDateTime(o.createdAt),
          fmtDateTime(o.expiry),
          expired ? (
            <Button key="x" variant="ghost" className="min-h-[30px] px-2 text-xs" disabled={busy} onClick={() => onExpire(o.id)}>
              Refund
            </Button>
          ) : (
            <Button key="c" variant="danger" className="min-h-[30px] px-2 text-xs" disabled={busy} onClick={() => onCancel(o.id)}>
              Cancel
            </Button>
          ),
        ]
      })}
    />
  )
}

export function OrderHistoryTable({ network, orders, logs }: { network: NetworkConfig; orders: OrderView[]; logs: ExecutionLog[] }) {
  return (
    <Table
      head={['Pair', 'Type', 'Side', 'Trigger', 'Amount in', 'Received', 'Exec. price', 'Status', 'When', 'Tx']}
      empty={{ title: 'No order history', body: 'Executed, cancelled and expired orders appear here.' }}
      rows={orders.map((o) => {
        const log = logs.find((l) => l.kind === 'order' && l.id === o.id)
        return [
          pair(network, o),
          ORDER_TYPE_LABEL[o.orderType],
          sideCell(o),
          triggerText(o),
          amountText(network, o),
          outText(network, o),
          o.executionPrice > 0n ? formatPrice18(o.executionPrice) : '-',
          statusBadge(o.status),
          fmtDateTime(o.executedAt || o.createdAt),
          <TxLink key="t" chainId={network.chainId} hash={log?.txHash} />,
        ]
      })}
    />
  )
}

export function DcaTable({
  network,
  dcas,
  onAction,
  busy,
}: {
  network: NetworkConfig
  dcas: DcaView[]
  onAction: (fn: 'pauseDca' | 'resumeDca' | 'cancelDca', id: bigint) => void
  busy: boolean
}) {
  const now = useNowSeconds()
  return (
    <Table
      head={['Token', 'Per buy', 'Every', 'Status', 'Next buy', 'Remaining', 'Buys done', 'Avg. price', 'Spent', '']}
      empty={{ title: 'No DCA strategies', body: 'Recurring buys you create appear here with their average price.' }}
      rows={dcas.map((d) => {
        const t = lookupToken(network, d.base)
        const avg = t ? averagePrice18(d.totalSpent, d.totalBought, t.decimals, network.quote.decimals) : 0n
        const live = d.status === DcaStatus.ACTIVE || d.status === DcaStatus.PAUSED
        return [
          t?.symbol ?? 'Token',
          `${formatToken(d.amountPerBuy, network.quote.decimals, 2)} ${network.quote.symbol}`,
          fmtDuration(d.interval),
          <Badge key="s" tone={d.status === DcaStatus.ACTIVE ? 'up' : d.status === DcaStatus.PAUSED ? 'warn' : 'mute'}>
            {DCA_STATUS_LABEL[d.status]}
            {d.status === DcaStatus.ACTIVE && d.reasonCode !== undefined && d.reasonCode !== 2 ? ` - ${DCA_REASON[d.reasonCode]}` : ''}
          </Badge>,
          live ? (d.nextExecution <= now ? 'Due' : `in ${fmtDuration(d.nextExecution - now)}`) : '-',
          `${formatToken(d.budgetRemaining, network.quote.decimals, 2)} ${network.quote.symbol}`,
          d.executions,
          avg > 0n ? formatPrice18(avg) : '-',
          `${formatToken(d.totalSpent, network.quote.decimals, 2)} ${network.quote.symbol}`,
          live ? (
            <div key="a" className="flex gap-1">
              {d.status === DcaStatus.ACTIVE ? (
                <Button variant="ghost" className="min-h-[30px] px-2 text-xs" disabled={busy} onClick={() => onAction('pauseDca', d.id)}>
                  Pause
                </Button>
              ) : (
                <Button variant="ghost" className="min-h-[30px] px-2 text-xs" disabled={busy} onClick={() => onAction('resumeDca', d.id)}>
                  Resume
                </Button>
              )}
              <Button variant="danger" className="min-h-[30px] px-2 text-xs" disabled={busy} onClick={() => onAction('cancelDca', d.id)}>
                Cancel
              </Button>
            </div>
          ) : (
            ''
          ),
        ]
      })}
    />
  )
}
