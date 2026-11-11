import { useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { useDcas, useExecutionLogs, useNowSeconds, useOracle, useOrders } from '@/trading/hooks'
import { useLocalTrades } from '@/trading/localTrades'
import { useTx } from '@/trading/tx'
import { ordersAbi } from '@/trading/ordersAbi'
import { averagePrice18, formatPrice18, formatToken } from '@/trading/math'
import { computePositions, unrealizedQuote, type Position } from '@/trading/portfolio'
import { fmtDateTime } from '@/trading/format'
import { ORDER_TYPE_LABEL, OrderType, Side, Status, type DcaView, type OrderView } from '@/trading/types'
import type { NetworkConfig } from '@/trading/networks'
import { Empty, Notice, Panel, Skeleton } from './ui'
import { DcaTable, OpenOrdersTable, OrderHistoryTable, Table, TxLink, lookupToken } from './OrderTables'

const TABS = [
  { id: 'open', label: 'Open orders' },
  { id: 'history', label: 'Order history' },
  { id: 'trades', label: 'Trade history' },
  { id: 'positions', label: 'Positions' },
  { id: 'dca', label: 'DCA strategies' },
  { id: 'protect', label: 'Stop-loss / Take-profit' },
  { id: 'failed', label: 'Failed / expired' },
] as const
type TabId = (typeof TABS)[number]['id']

const PROTECTIVE: number[] = [OrderType.STOP_LOSS, OrderType.TAKE_PROFIT, OrderType.STOP_LIMIT, OrderType.TRAILING_STOP, OrderType.OCO]

export function OrderTabs({ network }: { network: NetworkConfig }) {
  const { address } = useAccount()
  const [tab, setTab] = useState<TabId>('open')
  const orders = useOrders(network, address)
  const dcas = useDcas(network, address)
  const logs = useExecutionLogs(network, address)
  const local = useLocalTrades().filter((t) => t.chainId === network.chainId)
  const tx = useTx(network)
  const qc = useQueryClient()

  const all = useMemo(() => [...(orders.data ?? [])].sort((a, b) => Number(b.id - a.id)), [orders.data])
  const dcaList = useMemo(() => [...(dcas.data ?? [])].sort((a, b) => Number(b.id - a.id)), [dcas.data])
  const logList = logs.data?.logs ?? []

  const act = async (label: string, functionName: string, id: bigint) => {
    if (!network.ordersAddress) return
    try {
      await tx.write(label, { address: network.ordersAddress, abi: ordersAbi, functionName, args: [id] })
      void qc.invalidateQueries()
    } catch {
      /* surfaced by toast */
    }
  }

  const loading = Boolean(address) && (orders.isLoading || dcas.isLoading)
  const now = useNowSeconds()

  const counts: Partial<Record<TabId, number>> = {
    open: all.filter((o) => o.status === Status.OPEN).length,
    dca: dcaList.filter((d) => d.status <= 1).length,
  }

  let body: React.ReactNode
  if (!address) body = <Empty title="Connect a wallet">Your orders, history and positions are read from the order contract for your address.</Empty>
  else if (!network.ordersAddress) body = <Empty title="Order contract not configured on this network">Set the contract address in .env to see orders.</Empty>
  else if (loading) body = <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
  else if (orders.isError || dcas.isError) body = <div className="p-4"><Notice tone="error" title="Could not read orders">The RPC request failed. It will retry automatically.</Notice></div>
  else {
    switch (tab) {
      case 'open':
        body = (
          <OpenOrdersTable
            network={network}
            orders={all.filter((o) => o.status === Status.OPEN)}
            busy={tx.busy}
            onCancel={(id) => void act('Cancel order', 'cancelOrder', id)}
            onExpire={(id) => void act('Refund expired order', 'expireOrder', id)}
          />
        )
        break
      case 'history':
        body = <OrderHistoryTable network={network} orders={all.filter((o) => o.status !== Status.OPEN)} logs={logList} />
        break
      case 'trades': {
        const rows: { time: number; cells: React.ReactNode[] }[] = []
        for (const o of all.filter((x) => x.status === Status.EXECUTED)) {
          const t = lookupToken(network, o.base)
          const log = logList.find((l) => l.kind === 'order' && l.id === o.id)
          const buy = o.side === Side.BUY
          const outTok = buy ? t : network.quote
          rows.push({
            time: o.executedAt,
            cells: [
              fmtDateTime(o.executedAt),
              `${t?.symbol}/${network.quote.symbol}`,
              ORDER_TYPE_LABEL[o.orderType],
              <span key="s" className={buy ? 'text-up' : 'text-down'}>{buy ? 'Buy' : 'Sell'}</span>,
              formatPrice18(o.executionPrice),
              outTok ? `${formatToken(o.amountOut, outTok.decimals, 6)} ${outTok.symbol}` : '-',
              log && outTok ? `${formatToken(log.keeperFee, outTok.decimals, 6)} ${outTok.symbol}` : '-',
              <TxLink key="t" chainId={network.chainId} hash={log?.txHash} />,
            ],
          })
        }
        for (const l of logList.filter((x) => x.kind === 'dca')) {
          const d = dcaList.find((x) => x.id === l.id)
          const t = d ? lookupToken(network, d.base) : undefined
          if (!t) continue
          rows.push({
            time: l.time ?? 0,
            cells: [
              l.time ? fmtDateTime(l.time) : '-',
              `${t.symbol}/${network.quote.symbol}`,
              'DCA buy',
              <span key="s" className="text-up">Buy</span>,
              formatPrice18(averagePrice18(l.amountIn, l.net + l.keeperFee, t.decimals, network.quote.decimals)),
              `${formatToken(l.net, t.decimals, 6)} ${t.symbol}`,
              `${formatToken(l.keeperFee, t.decimals, 6)} ${t.symbol}`,
              <TxLink key="t" chainId={network.chainId} hash={l.txHash} />,
            ],
          })
        }
        for (const m of local) {
          rows.push({
            time: m.time,
            cells: [
              fmtDateTime(m.time),
              `${m.baseSymbol}/${network.quote.symbol}`,
              'Market swap',
              <span key="s" className={m.side === Side.BUY ? 'text-up' : 'text-down'}>{m.side === Side.BUY ? 'Buy' : 'Sell'}</span>,
              '-',
              `min ${m.minBuyAmount} ${m.buySymbol}`,
              '-',
              <TxLink key="t" chainId={network.chainId} hash={m.hash} />,
            ],
          })
        }
        rows.sort((a, b) => b.time - a.time)
        body = (
          <>
            <Table
              head={['When', 'Pair', 'Kind', 'Side', 'Price', 'Received', 'Keeper fee', 'Tx']}
              rows={rows.map((r) => r.cells)}
              empty={{ title: 'No trades yet', body: 'Filled orders, DCA buys and market swaps sent from this browser appear here.' }}
            />
            {logs.data?.partial && <div className="px-3 pb-3"><Notice>Execution history may be incomplete because the RPC limited the log range. It will keep filling in on the next refresh.</Notice></div>}
          </>
        )
        break
      }
      case 'positions':
        body = <PositionsTable network={network} orders={all} dcas={dcaList} fees={logList} />
        break
      case 'dca':
        body = <DcaTable network={network} dcas={dcaList} busy={tx.busy} onAction={(fn, id) => void act(fn === 'pauseDca' ? 'Pause plan' : fn === 'resumeDca' ? 'Resume plan' : 'Cancel plan', fn, id)} />
        break
      case 'protect':
        body = (
          <OrderHistoryTable
            network={network}
            orders={all.filter((o) => PROTECTIVE.includes(o.orderType))}
            logs={logList}
          />
        )
        break
      case 'failed': {
        const failed = all.filter((o) => o.status === Status.EXPIRED || (o.status === Status.OPEN && now >= o.expiry))
        const stuck = all.filter((o) => o.status === Status.OPEN && now < o.expiry && o.reasonCode === 0)
        body = (
          <>
            {stuck.length > 0 && (
              <div className="px-3 pt-3">
                <Notice tone="warn" title={`${stuck.length} order(s) are triggered but not yet filled`}>
                  They wait for a keeper. If the market is worse than your limit or minimum output, they stay open until they expire.
                </Notice>
              </div>
            )}
            <OrderHistoryTable network={network} orders={failed} logs={logList} />
          </>
        )
        break
      }
    }
  }

  return (
    <Panel>
      <div className="thin-scroll flex gap-1 overflow-x-auto border-b border-line px-2 pt-2" role="tablist" aria-label="Orders">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={clsx('flex min-h-[38px] items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-xs transition', tab === t.id ? 'border-accent text-ink' : 'border-transparent text-mute hover:text-ink')}
          >
            {t.label}
            {counts[t.id] ? <span className="num rounded bg-raised px-1.5 text-[10px]">{counts[t.id]}</span> : null}
          </button>
        ))}
      </div>
      {body}
    </Panel>
  )
}

function PositionRow({ network, p, fees }: { network: NetworkConfig; p: Position; fees: bigint }) {
  const token = lookupToken(network, p.base)
  const oracle = useOracle(network, token)
  if (!token) return null
  const price = oracle.data?.status === 'ok' ? oracle.data.price18 : null
  const unreal = price !== null ? unrealizedQuote(p, price, token.decimals, network.quote.decimals) : null
  const q = (v: bigint) => `${v < 0n ? '-' : ''}${formatToken(v < 0n ? -v : v, network.quote.decimals, 2)} ${network.quote.symbol}`
  const tone = (v: bigint | null) => (v === null ? '' : v >= 0n ? 'text-up' : 'text-down')
  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="px-3 py-2.5">{token.symbol}</td>
      <td className="num px-3 py-2.5">{formatToken(p.quantity, token.decimals, 6)}</td>
      <td className="num px-3 py-2.5">{p.avgEntry18 > 0n ? formatPrice18(p.avgEntry18) : '-'}</td>
      <td className="num px-3 py-2.5">{price !== null ? formatPrice18(price) : 'No oracle'}</td>
      <td className={clsx('num px-3 py-2.5', tone(p.realizedQuote))}>{q(p.realizedQuote)}</td>
      <td className={clsx('num px-3 py-2.5', tone(unreal))}>{unreal !== null ? q(unreal) : '-'}</td>
      <td className="num px-3 py-2.5">{formatToken(fees, token.decimals, 6)} {token.symbol}</td>
    </tr>
  )
}

function PositionsTable({ network, orders, dcas, fees }: { network: NetworkConfig; orders: OrderView[]; dcas: DcaView[]; fees: { kind: string; id: bigint; keeperFee: bigint }[] }) {
  const positions = computePositions(orders, dcas, { base: (a) => lookupToken(network, a)?.decimals, quote: network.quote.decimals })
  if (positions.length === 0) return <Empty title="No positions yet">Positions come from orders and DCA plans filled through the order contract.</Empty>
  const feeFor = (base: string) => {
    let sum = 0n
    for (const l of fees) {
      if (l.kind === 'dca') {
        const d = dcas.find((x) => x.id === l.id)
        if (d?.base.toLowerCase() === base) sum += l.keeperFee
      } else {
        const o = orders.find((x) => x.id === l.id)
        if (o && o.base.toLowerCase() === base && o.side === Side.BUY) sum += l.keeperFee
      }
    }
    return sum
  }
  return (
    <>
      <div className="thin-scroll overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead>
            <tr className="border-b border-line text-mute">
              {['Token', 'Quantity', 'Avg. entry', 'Oracle price', 'Realized PnL', 'Unrealized PnL', 'Keeper fees (base)'].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <PositionRow key={p.base} network={network} p={p} fees={feeFor(p.base)} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 pb-3">
        <Notice>Positions include only fills made through the order contract. Wallet swaps made elsewhere are not counted.</Notice>
      </div>
    </>
  )
}
