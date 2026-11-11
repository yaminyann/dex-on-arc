import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { AlertTriangle } from 'lucide-react'
import { getAggregator } from '@/trading/aggregator'
import { useBackendHealth } from '@/trading/hooks'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import { formatToken, parseTokenAmount, pctDiff, WAD } from '@/trading/math'
import { Badge, Notice, Panel, Skeleton } from './ui'

const SIZES = ['100', '1000', '10000']

/** There is no order book on Arc AMMs, so this shows real aggregator quotes at several sizes instead. */
export function DepthPanel({ network, base }: { network: NetworkConfig; base: TokenInfo | undefined }) {
  const { address } = useAccount()
  const health = useBackendHealth()
  const agg = getAggregator(network)
  const reason = agg.unavailableReason()
  const isTestRouter = agg.id === 'test-router'
  const ready = !reason && !isTestRouter && Boolean(base && address) && (health.data?.gateway ? health.data.gateway.configured : health.data?.zeroEx.configured) === true

  const depth = useQuery({
    queryKey: ['depth', network.key, base?.address, address],
    enabled: ready,
    refetchInterval: 20_000,
    retry: false,
    queryFn: async () => {
      const out = await Promise.all(
        SIZES.map(async (s) => {
          const sell = parseTokenAmount(s, network.quote.decimals)!
          const q = await agg.price({ chainId: network.chainId, sellToken: network.quote.address, buyToken: base!.address, sellAmount: sell, taker: address!, slippageBps: 50 })
          if (!q) return { size: s, price: null as bigint | null }
          const price = (q.sellAmount * WAD * 10n ** BigInt(base!.decimals)) / (q.buyAmount * 10n ** BigInt(network.quote.decimals))
          return { size: s, price }
        }),
      )
      return out
    },
  })

  return (
    <Panel className="p-4">
      <h3 className="font-display text-sm font-semibold">Swap depth</h3>
      <p className="mb-2 mt-0.5 text-xs text-mute">Arc liquidity is AMM-based, so there is no order book. Prices below are live aggregator quotes for buying {base?.symbol ?? 'the token'} with USDC.</p>
      {reason ? (
        <Notice tone="warn">{reason}</Notice>
      ) : isTestRouter ? (
        <Notice>The test router fills any size at the feed price minus 0.10%, so it has no depth to show. Real depth comes from 0x quotes on Arc mainnet.</Notice>
      ) : !base ? (
        <Notice>Select a token.</Notice>
      ) : health.data && !(health.data.gateway ? health.data.gateway.configured : health.data.zeroEx.configured) ? (
        <Notice tone="warn">No quote provider is available. Check the backend providers.</Notice>
      ) : !address ? (
        <Notice>Connect a wallet to load quotes.</Notice>
      ) : depth.isLoading ? (
        <Skeleton className="h-20" />
      ) : depth.isError ? (
        <Notice tone="error">{depth.error instanceof Error ? depth.error.message : 'Quote failed'}</Notice>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-mute">
              <th className="py-1 font-medium">Size (USDC)</th>
              <th className="py-1 font-medium">Avg. price</th>
              <th className="py-1 text-right font-medium">Impact</th>
            </tr>
          </thead>
          <tbody>
            {depth.data?.map((d, i) => {
              const first = depth.data?.[0]?.price
              const impact = d.price && first ? pctDiff(d.price, first) : null
              return (
                <tr key={d.size} className="num">
                  <td className="py-1">{Number(d.size).toLocaleString()}</td>
                  <td className="py-1">{d.price ? formatToken(d.price, 18, 4) : 'No liquidity'}</td>
                  <td className="py-1 text-right text-mute">{i === 0 ? 'base' : impact !== null ? `${(impact * 100).toFixed(2)}%` : '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

export function AutomationCard() {
  const health = useBackendHealth()
  return (
    <Panel className="p-4">
      <h3 className="font-display text-sm font-semibold">Execution and automation</h3>
      <p className="mb-2 mt-0.5 text-xs text-mute">Your funds stay in the contract and orders run without your browser. Something has to submit the execution, though.</p>
      {health.isLoading ? (
        <Skeleton className="h-20" />
      ) : health.isError ? (
        <Notice tone="warn" title="Backend offline">Run `bun run server` to see provider status and to use swap quotes.</Notice>
      ) : (
        <ul className="space-y-2">
          {health.data?.automationProviders.map((p) => (
            <li key={p.id} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{p.name}</span>
                <Badge tone={p.state === 'active' ? 'up' : p.state === 'available' ? 'accent' : p.state === 'unsupported' ? 'down' : 'warn'}>{p.state}</Badge>
              </div>
              <div className="text-mute">{p.summary}</div>
            </li>
          ))}
        </ul>
      )}
      {health.data?.keeper.lastError && (
        <div className="mt-2 flex gap-1.5 text-[11px] text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {health.data.keeper.lastError}
        </div>
      )}
    </Panel>
  )
}

export function NetworkBanner({ network }: { network: NetworkConfig }) {
  if (network.isTestnet) {
    return (
      <Notice tone="info" title="Arc Testnet">
        0x and Chainlink Data Feeds are not available on Arc Testnet. To let you try every order type anyway, the test assets (tBTC, tETH, tSOL) use public test price feeds that anyone can move and a test router that swaps at that price. Those prices are not market prices. EURC, cirBTC and WETH have no feed here, so they cannot be traded. Charts show real reference data.
      </Notice>
    )
  }
  return (
    <Notice tone="warn" title="Arc mainnet: real funds">
      Transactions here are irreversible. {network.bases.length === 0 ? 'No tradable tokens are configured yet: add tokens in src/trading/networks.ts and oracle feeds on your own deployed contract. ' : ''}
      {network.ordersAddress ? '' : 'The mainnet order contract address (VITE_ORDERS_ADDRESS_ARC_MAINNET) is not set.'}
    </Notice>
  )
}
