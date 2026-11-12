import { useState } from 'react'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import { useSettings } from '@/trading/settings'
import { useOracle } from '@/trading/hooks'
import { useMarket, type Timeframe } from '@/trading/market'
import { useIndicativePrice, useTokenList } from '@/trading/tokens'
import { Button, Panel, Skeleton } from './ui'
import { PairBar, TokenSelector } from './PairBar'
import { PriceChart } from './PriceChart'
import { TradePanel } from './TradePanel'
import { OrderTabs } from './OrderTabs'
import { NetworkBanner } from './NetworkBanner'
import { TestnetTools } from './TestnetTools'

export function Terminal({ network }: { network: NetworkConfig }) {
  const { setNetworkKey } = useSettings()
  const [baseAddr, setBaseAddr] = useState<string | undefined>()
  const [tf, setTf] = useState<Timeframe>('1h')
  const list = useTokenList(network)
  const bases = list.tokens
  // Derived: an address picked on another network falls back to this network's first token.
  const base: TokenInfo | undefined = bases.find((t) => t.address === baseAddr) ?? bases[0]

  const hasReference = Boolean(base?.referenceProduct)
  const market = useMarket(base?.referenceProduct, tf)
  const oracle = useOracle(network, base)
  const indicative = useIndicativePrice(network, base, !hasReference && !network.isTestnet)

  // Nothing to trade yet: say why, instead of a shell of disabled panels.
  if (!base) {
    return (
      <div className="mx-auto max-w-xl space-y-4 pt-6">
        <NetworkBanner network={network} />
        <Panel className="p-8 text-center">
          {list.loading ? (
            <div className="space-y-3">
              <Skeleton className="mx-auto h-5 w-48" />
              <Skeleton className="mx-auto h-4 w-64" />
            </div>
          ) : list.error ? (
            <>
              <h1 className="font-display text-lg font-semibold">Could not load the token list</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm text-mute">The backend could not reach the token registry. Check that the API is running, then retry.</p>
              <Button variant="primary" className="mt-5" onClick={list.retry}>
                Retry
              </Button>
            </>
          ) : (
            <>
              <h1 className="font-display text-lg font-semibold">Trading is not enabled on {network.label} yet</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm text-mute">No tokens are available for this network. Switch to Arc Testnet to try every order type with test tokens.</p>
              <Button variant="primary" className="mt-5" onClick={() => setNetworkKey('arc-testnet')}>
                Use Arc Testnet
              </Button>
            </>
          )}
        </Panel>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <NetworkBanner network={network} />
      {/* One grid so the order form sits right under the price header on small screens, beside the chart on wide ones. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Panel className="p-4 lg:col-start-1 lg:row-start-1">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <TokenSelector network={network} bases={bases} value={base} onChange={(t) => setBaseAddr(t.address)} />
            <PairBar market={market} oracle={oracle.data} oracleLoading={oracle.isLoading} hasReference={hasReference} indicative={{ price18: indicative.data ?? null, loading: indicative.isLoading }} />
          </div>
        </Panel>

        <aside className="min-w-0 space-y-4 lg:col-start-2 lg:row-span-3 lg:row-start-1">
          <TradePanel network={network} base={base} oracle={oracle.data} />
          <TestnetTools network={network} base={base} />
        </aside>

        {hasReference ? (
          <Panel className="min-w-0 lg:col-start-1 lg:row-start-2">
            <PriceChart
              candles={market.candles}
              loading={market.loading}
              error={market.error}
              timeframe={tf}
              onTimeframe={setTf}
              source={base.referenceProduct ?? null}
              live={market.live}
            />
          </Panel>
        ) : (
          <Panel className="min-w-0 p-4 text-xs text-mute lg:col-start-1 lg:row-start-2">
            No reference chart exists for {base.symbol}. Prices come from live aggregator quotes, and the swap form shows the route for your exact size.
          </Panel>
        )}

        {network.ordersAddress && (
          <div className="min-w-0 lg:col-start-1 lg:row-start-3">
            <OrderTabs network={network} />
          </div>
        )}
      </div>
    </div>
  )
}
