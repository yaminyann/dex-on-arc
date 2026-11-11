/**
 * RPC selection shared by the keeper and the quote gateway.
 *
 * Order of preference for a chain (`name` is `Arc` or `Arc_Testnet`):
 *   1. RPC_URL_<name>: one URL or a comma-separated list. With several, requests fail over in order.
 *   2. The provisioned proxy (Arc Studio only).
 *   3. The public RPC from the generated chain facts.
 */
import { createPublicClient, fallback, http, type Chain, type PublicClient, type Transport } from 'viem'
import { arc, arcTestnet } from 'viem/chains'
import { getChain } from '../src/onchain-facts'

export function resolveRpcUrls(name: string, fallbackUrls: readonly string[], env: Record<string, string | undefined> = process.env): string[] {
  const own = (env[`RPC_URL_${name}`] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (own.length) return own
  const proxied = (env.RPC_PROXY_CHAINS ?? '').split(',').includes(name)
  if (proxied && env.RPC_PROXY_BASE_URL) return [`${env.RPC_PROXY_BASE_URL}/api/rpc/${name}?_rpc_token=${env.RPC_PROXY_TOKEN}`]
  return [...fallbackUrls]
}

/** A single URL uses plain http; several use viem's fallback transport (retry the next endpoint on failure). */
export function transportFor(urls: readonly string[]): Transport {
  if (urls.length <= 1) return http(urls[0])
  return fallback(
    urls.map((u) => http(u, { retryCount: 1, timeout: 8000 })),
    { rank: false, retryCount: 1 },
  )
}

export const CHAIN_NAMES: Readonly<Record<number, { chain: Chain; rpcName: string }>> = {
  [arc.id]: { chain: arc, rpcName: 'Arc' },
  [arcTestnet.id]: { chain: arcTestnet, rpcName: 'Arc_Testnet' },
}

const clients = new Map<number, PublicClient>()

/** Cached read client for a supported chain. */
export function publicClientFor(chainId: number): PublicClient {
  const hit = clients.get(chainId)
  if (hit) return hit
  const entry = CHAIN_NAMES[chainId]
  const facts = getChain(chainId)
  if (!entry || !facts) throw new Error(`Unsupported chain ${chainId}`)
  const client = createPublicClient({ chain: entry.chain, transport: transportFor(resolveRpcUrls(entry.rpcName, facts.rpcUrls)) }) as PublicClient
  clients.set(chainId, client)
  return client
}
