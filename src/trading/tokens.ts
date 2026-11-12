import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { getAggregator } from './aggregator'
import { WAD } from './math'
import { tradableBases, type NetworkConfig, type TokenInfo } from './networks'

interface ListedToken {
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI?: string
}

/** Reference charts exist only for assets Coinbase lists. Matched on the aggregator's own address for the token. */
const REFERENCE_BY_SYMBOL: Record<string, string> = { cirBTC: 'BTC-USD', WETH: 'ETH-USD', EURC: 'EURC-USDC' }

export async function fetchTokenList(chainId: number): Promise<ListedToken[]> {
  const res = await fetch(`/api/tokens?chainId=${chainId}`)
  if (!res.ok) throw new Error('The token list is unavailable right now.')
  const json = (await res.json()) as { tokens?: ListedToken[] }
  return json.tokens ?? []
}

export interface TokenListState {
  tokens: TokenInfo[]
  loading: boolean
  error: boolean
  retry: () => void
}

/**
 * Tokens the terminal can trade on a network. Testnet: the harness assets that have a test feed.
 * Mainnet: everything the aggregator can route (a filtered registry served by the backend), plus any
 * token configured by hand. Market swaps work for all of them; conditional orders and DCA still need
 * an oracle feed on the order contract and say so when a token has none.
 */
export function useTokenList(network: NetworkConfig): TokenListState {
  const remote = !network.isTestnet
  const q = useQuery({
    queryKey: ['token-list', network.chainId],
    enabled: remote,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () => fetchTokenList(network.chainId),
  })

  if (!remote) return { tokens: tradableBases(network), loading: false, error: false, retry: () => undefined }

  const quote = network.quote.address.toLowerCase()
  const configured = network.bases
  const seen = new Set<string>([quote, ...configured.map((t) => t.address.toLowerCase())])
  const listed: TokenInfo[] = []
  for (const t of q.data ?? []) {
    const key = t.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    listed.push({ symbol: t.symbol, name: t.name, address: t.address as Address, decimals: t.decimals, logoURI: t.logoURI, referenceProduct: REFERENCE_BY_SYMBOL[t.symbol] })
  }
  return { tokens: [...configured, ...listed], loading: q.isLoading, error: q.isError, retry: () => void q.refetch() }
}

const DEAD_TAKER: Address = '0x000000000000000000000000000000000000dEaD'

/** Aggregator price (quote per whole token) for a 10 USDC trade. Used where no reference chart exists. */
export function useIndicativePrice(network: NetworkConfig, base: TokenInfo | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['indicative-price', network.key, base?.address],
    enabled: enabled && Boolean(base),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
    queryFn: async (): Promise<bigint | null> => {
      const sellAmount = 10n * 10n ** BigInt(network.quote.decimals)
      const q = await getAggregator(network).price({ chainId: network.chainId, sellToken: network.quote.address, buyToken: base!.address, sellAmount, taker: DEAD_TAKER, slippageBps: 50 })
      if (!q || q.buyAmount === 0n) return null
      return (q.sellAmount * WAD * 10n ** BigInt(base!.decimals)) / (q.buyAmount * 10n ** BigInt(network.quote.decimals))
    },
  })
}
