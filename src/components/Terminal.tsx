import { useState } from 'react'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import { useOracle } from '@/trading/hooks'
import { useMarket, type Timeframe } from '@/trading/market'
import { Empty, Panel } from './ui'
import { PairBar, TokenSelector } from './PairBar'
import { PriceChart } from './PriceChart'
import { TradePanel } from './TradePanel'
import { OrderTabs } from './OrderTabs'
import { AutomationCard, DepthPanel, NetworkBanner } from './SidePanels'
import { TestnetTools } from './TestnetTools'

export function Terminal({ network }: { network: NetworkConfig }) {
  const [baseAddr, setBaseAddr] = useState<string | undefined>()
  const [tf, setTf] = useState<Timeframe>('1h')
  // Derived: an address picked on another network falls back to this network's first token.
  const base: TokenInfo | undefined = network.bases.find((t) => t.address === baseAddr) ?? network.bases[0]
  const setBase = (t: TokenInfo) => setBaseAddr(t.address)

  const market = useMarket(base?.referenceProduct, tf)
  const oracle = useOracle(network, base)

  return (
    <div className="space-y-4">
      <NetworkBanner network={network} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <Panel className="p-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <TokenSelector network={network} value={base} onChange={setBase} />
              {base && <PairBar market={market} oracle={oracle.data} oracleLoading={oracle.isLoading} />}
            </div>
          </Panel>
          <Panel>
            {base ? (
              <PriceChart
                candles={market.candles}
                loading={market.loading}
                error={market.error}
                timeframe={tf}
                onTimeframe={setTf}
                source={base.referenceProduct ?? null}
                live={market.live}
              />
            ) : (
              <Empty title="No chart">Pick a token to load its reference market.</Empty>
            )}
          </Panel>
          <OrderTabs network={network} />
        </div>
        <aside className="space-y-4">
          <TradePanel network={network} base={base} oracle={oracle.data} />
          <TestnetTools network={network} base={base} />
          <DepthPanel network={network} base={base} />
          <AutomationCard />
        </aside>
      </div>
    </div>
  )
}
