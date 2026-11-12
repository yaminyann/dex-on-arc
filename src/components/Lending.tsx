import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Landmark, ShieldCheck, TrendingUp } from 'lucide-react'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import { useTokenList } from '@/trading/tokens'
import { useBalances } from '@/trading/hooks'
import { formatToken } from '@/trading/math'
import { Badge, Button, Field, Notice, Panel, Row, Segmented } from './ui'
import { TokenBase } from './TokenIcon'

type Action = 'supply' | 'borrow' | 'withdraw' | 'repay'

const ACTIONS: { id: Action; label: string }[] = [
  { id: 'supply', label: 'Supply' },
  { id: 'borrow', label: 'Borrow' },
  { id: 'withdraw', label: 'Withdraw' },
  { id: 'repay', label: 'Repay' },
]

const DASH = '—'

/**
 * Lending, as a design. No lending market is connected yet, so every rate and total shows a dash instead
 * of an invented number, and the buttons are disabled. Wallet balances are real. The layout is the one
 * a live market will drop into: markets table, supply/borrow ticket, position and health factor.
 */
export function Lending({ network }: { network: NetworkConfig }) {
  const { address } = useAccount()
  const list = useTokenList(network).tokens
  const balances = useBalances(network, address)
  const [action, setAction] = useState<Action>('supply')
  const [picked, setPicked] = useState<string | undefined>()

  // USDC first, then the first few tokens of the network: the ones a market would list first.
  const assets: TokenInfo[] = [network.quote, ...list.filter((t) => t.address !== network.quote.address).slice(0, 5)]
  const asset = assets.find((t) => t.address === picked) ?? assets[0]
  const balance = (t: TokenInfo) => balances.data?.[t.address.toLowerCase()]
  const bal = balance(asset)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-xl font-semibold">Lending</h1>
        <Badge tone="accent">Preview</Badge>
      </div>

      <Notice tone="info" title="Lending is not live yet">
        No lending market is connected on {network.label}, so rates and totals show a dash rather than made-up numbers. This page is the design a live market will use. Your wallet balances below are real.
      </Notice>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Total supplied', DASH],
          ['Total borrowed', DASH],
          ['Available liquidity', DASH],
          ['Your net APY', DASH],
        ].map(([label, value]) => (
          <Panel key={label} className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-mute">{label}</div>
            <div className="num mt-1 font-display text-xl font-semibold text-mute">{value}</div>
          </Panel>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <Panel>
            <div className="border-b border-line px-4 py-3 font-display text-sm font-semibold">Markets</div>
            <div className="thin-scroll overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead>
                  <tr className="border-b border-line text-mute">
                    {['Asset', 'Supply APY', 'Borrow APY', 'Total supplied', 'Total borrowed', 'Utilization', 'Wallet'].map((h) => (
                      <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {assets.map((t) => (
                    <tr key={t.address} onClick={() => setPicked(t.address)} className={`cursor-pointer border-b border-line/60 last:border-0 hover:bg-raised/40 ${asset.address === t.address ? 'bg-raised/60' : ''}`}>
                      <td className="px-3 py-3">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <TokenBase token={t} size={20} />
                          {t.symbol}
                        </span>
                      </td>
                      {[0, 1, 2, 3, 4].map((i) => (
                        <td key={i} className="num px-3 py-3 text-mute">
                          {DASH}
                        </td>
                      ))}
                      <td className="num px-3 py-3">{address ? (balance(t) === undefined ? '…' : formatToken(balance(t) ?? 0n, t.decimals, 4)) : DASH}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: <Landmark className="h-4 w-4" />, title: 'Supply to earn', body: 'Deposit an asset into a market and earn interest paid by borrowers. Withdraw whenever liquidity allows.' },
              { icon: <TrendingUp className="h-4 w-4" />, title: 'Borrow against collateral', body: 'Your supplied assets back a loan. Borrow up to the collateral factor and pay a variable rate.' },
              { icon: <ShieldCheck className="h-4 w-4" />, title: 'Keep your health factor above 1', body: 'If collateral value falls too far, positions can be liquidated. The ticket shows the health factor before you sign.' },
            ].map((c) => (
              <Panel key={c.title} className="p-4">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15 text-accent">{c.icon}</span>
                <h3 className="mt-3 text-sm font-semibold">{c.title}</h3>
                <p className="mt-1 text-xs text-mute">{c.body}</p>
              </Panel>
            ))}
          </div>
        </div>

        <aside className="min-w-0 space-y-4">
          <Panel className="p-4">
            <Segmented className="mb-4 w-full" value={action} onChange={setAction} options={ACTIONS} />
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2">
                <TokenBase token={asset} size={20} />
                <span className="text-sm font-medium">{asset.symbol}</span>
                <span className="ml-auto text-xs text-mute">Select a market on the left</span>
              </div>
              <Field label="Amount" placeholder="0.00" disabled right={asset.symbol} hint={address && bal !== undefined ? `Wallet ${formatToken(bal, asset.decimals, 4)}` : undefined} />
              <div className="rounded-lg border border-line px-3 py-1.5">
                <Row label={action === 'borrow' || action === 'repay' ? 'Borrow APY' : 'Supply APY'} value={DASH} tone="mute" />
                <Row label="Collateral factor" value={DASH} tone="mute" />
                <Row label="Health factor after" value={DASH} tone="mute" />
                <Row label="Network fee" value={DASH} tone="mute" />
              </div>
              <Button variant="primary" className="w-full" disabled>
                {ACTIONS.find((a) => a.id === action)?.label} not available yet
              </Button>
            </div>
          </Panel>

          <Panel className="p-4">
            <h3 className="font-display text-sm font-semibold">Your position</h3>
            <div className="mt-2 divide-y divide-line">
              <Row label="Supplied" value={DASH} tone="mute" />
              <Row label="Borrowed" value={DASH} tone="mute" />
              <Row label="Health factor" value={DASH} tone="mute" />
            </div>
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-[11px] text-mute">
                <span>Borrow limit used</span>
                <span>{DASH}</span>
              </div>
              <div className="h-1.5 rounded-full bg-line" />
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  )
}
