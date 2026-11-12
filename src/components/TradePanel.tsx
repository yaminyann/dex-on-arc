import { useState } from 'react'
import { useAccount } from 'wagmi'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import type { OracleState } from '@/trading/hooks'
import { useBackendHealth } from '@/trading/hooks'
import { useSettings } from '@/trading/settings'
import { Side } from '@/trading/types'
import { Notice, Panel, Segmented } from './ui'
import { ConditionalForm, type ConditionalKind } from './ConditionalForm'
import { DcaForm } from './DcaForm'
import { MarketForm } from './MarketForm'
import type { OkOracle, TradeCtx } from './TradeShared'

type Kind = 'market' | ConditionalKind | 'dca'

const KINDS: { id: Kind; label: string; sellOnly?: boolean; buyOnly?: boolean }[] = [
  { id: 'market', label: 'Market' },
  { id: 'limit', label: 'Limit' },
  { id: 'stop_loss', label: 'Stop-loss', sellOnly: true },
  { id: 'take_profit', label: 'Take-profit', sellOnly: true },
  { id: 'stop_limit', label: 'Stop-limit', sellOnly: true },
  { id: 'trailing', label: 'Trailing stop', sellOnly: true },
  { id: 'oco', label: 'OCO', sellOnly: true },
  { id: 'dca', label: 'DCA', buyOnly: true },
]

export function TradePanel({ network, base, oracle }: { network: NetworkConfig; base: TokenInfo | undefined; oracle: OracleState | undefined }) {
  const { address } = useAccount()
  const { slippageBps, expiryDays, defaultOrderType } = useSettings()
  const health = useBackendHealth()
  const [pickedSide, setSide] = useState<number>(Side.BUY)
  const [kind, setKind] = useState<Kind>(defaultOrderType)
  const current = KINDS.find((k) => k.id === kind)!
  // The order type can force a side (stops are sell-only, DCA is buy-only).
  const side = current.sellOnly ? Side.SELL : current.buyOnly ? Side.BUY : pickedSide

  const ctxOracle: OkOracle | undefined = oracle?.status === 'ok' ? oracle : undefined
  const ctx: TradeCtx | null = base ? { network, base, side, oracle: ctxOracle, address, slippageBps, expiryDays } : null

  // Why conditional orders can't be placed right now, if anything.
  let blocker: { title: string; body: string } | null = null
  if (kind !== 'market') {
    if (!network.ordersAddress) {
      blocker = { title: 'Orders are not available here yet', body: 'The order contract is not configured for this network. Market swaps still work where a router exists.' }
    } else if (oracle?.status === 'no-feed') {
      blocker = {
        title: `No oracle feed for ${base?.symbol ?? 'this token'}`,
        body: 'Orders need a validated onchain price and this token has no feed on the contract yet.',
      }
    } else if (oracle?.status === 'unavailable') {
      blocker = { title: 'Oracle price unavailable', body: oracle.message }
    }
  }

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xl">Trade</h2>
        <Segmented
          value={side}
          onChange={setSide}
          tone={(v) => (v === Side.BUY ? 'text-up' : 'text-down')}
          options={[
            { id: Side.BUY, label: 'Buy', disabled: current.sellOnly },
            { id: Side.SELL, label: 'Sell', disabled: current.buyOnly },
          ]}
        />
      </div>

      <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Order type">
        {KINDS.map((k) => (
          <button
            key={k.id}
            role="tab"
            aria-selected={k.id === kind}
            onClick={() => setKind(k.id)}
            className={`min-h-[40px] whitespace-nowrap border px-3 text-xs font-bold ${k.id === kind ? 'border-line bg-accent text-accent-ink' : 'border-line/30 hover:border-line hover:bg-raised'}`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {!ctx ? (
        <Notice tone="warn" title="No tradable tokens on this network">Select a token.</Notice>
      ) : blocker ? (
        <Notice tone="warn" title={blocker.title}>
          {blocker.body}
        </Notice>
      ) : kind === 'market' ? (
        <MarketForm ctx={ctx} />
      ) : kind === 'dca' ? (
        <DcaForm ctx={ctx} />
      ) : (
        <ConditionalForm key={`${kind}-${side}-${base?.address}`} ctx={ctx} kind={kind} />
      )}

      {kind !== 'market' && !blocker && (
        <div className="mt-3">
          <Notice>
            Orders fill when a keeper submits them, even with your browser closed. {health.data?.keeper.running ? 'The built-in keeper is running.' : 'The built-in keeper is not running, so orders wait until a keeper runs.'}
          </Notice>
        </div>
      )}
    </Panel>
  )
}
