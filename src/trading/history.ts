import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'

/**
 * Server-side history from the backend indexer (optional). Market swaps are not recorded by the order
 * contract, so the browser reports each confirmed swap hash; the backend re-derives the amounts from the
 * chain, which means a failed or forged report can never put wrong data in the history.
 */
export interface ServerSwap {
  chainId: number
  txHash: string
  owner: string
  target: string
  sellToken: string
  sellAmount: string
  buyToken: string
  buyAmount: string
  blockNumber: number
  blockTime: number
}

/** Best effort: the swap is already final onchain, so a failed report only means a later retry or none. */
export async function reportSwap(chainId: number, hash: Hex): Promise<void> {
  try {
    await fetch('/api/swaps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId, hash }) })
  } catch {
    /* backend offline or indexer disabled */
  }
}

export function useServerSwaps(chainId: number, owner: Address | undefined) {
  return useQuery({
    queryKey: ['server-swaps', chainId, owner],
    enabled: Boolean(owner),
    retry: false,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ServerSwap[]> => {
      const res = await fetch(`/api/swaps?owner=${owner}&limit=50`)
      if (!res.ok) return []
      const body = (await res.json()) as { swaps?: ServerSwap[] }
      return (body.swaps ?? []).filter((s) => s.chainId === chainId)
    },
  })
}
