/** Reads for the owner/admin page: contract settings, what the owner changed, and pending timelocked changes. */
import { useQuery } from '@tanstack/react-query'
import { useAccount, usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import { ordersAbi } from './ordersAbi'
import type { NetworkConfig } from './networks'

export interface ContractState {
  owner: Address
  pendingOwner: Address | null
  paused: boolean
  keeperFeeBps: number
  minOrderQuote: bigint
  configDelay: number
  nextOrderId: bigint
  nextDcaId: bigint
}

/** Contract-wide settings in one multicall. Refreshed often so a pause from another device shows up. */
export function useContractState(network: NetworkConfig) {
  const client = usePublicClient({ chainId: network.chainId })
  const orders = network.ordersAddress
  return useQuery({
    queryKey: ['admin-state', network.key, orders],
    enabled: Boolean(client && orders),
    refetchInterval: 10_000,
    queryFn: async (): Promise<ContractState> => {
      const base = { address: orders!, abi: ordersAbi } as const
      const r = await client!.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: 'owner' },
          { ...base, functionName: 'pendingOwner' },
          { ...base, functionName: 'paused' },
          { ...base, functionName: 'keeperFeeBps' },
          { ...base, functionName: 'minOrderQuote' },
          { ...base, functionName: 'configDelay' },
          { ...base, functionName: 'nextOrderId' },
          { ...base, functionName: 'nextDcaId' },
        ],
      })
      const pendingOwner = r[1]
      return {
        owner: r[0],
        pendingOwner: /^0x0{40}$/.test(pendingOwner) ? null : pendingOwner,
        paused: r[2],
        keeperFeeBps: Number(r[3]),
        minOrderQuote: r[4],
        configDelay: Number(r[5]),
        nextOrderId: r[6],
        nextDcaId: r[7],
      }
    },
  })
}

/** True when the connected wallet is the contract owner. Controls whether the Admin page is offered. */
export function useIsOwner(network: NetworkConfig): { isOwner: boolean; loading: boolean } {
  const { address } = useAccount()
  const state = useContractState(network)
  const owner = state.data?.owner
  return { isOwner: Boolean(address && owner && address.toLowerCase() === owner.toLowerCase()), loading: state.isLoading }
}

export interface AdminEvent {
  name: string
  blockTime: number
  txHash: string
  args: Record<string, unknown>
}

export interface PendingChange {
  changeId: `0x${string}`
  eta: number
  subject: Address
  feed: Address
  maxStaleness: number
  isToken: boolean
  allowed: boolean
}

export interface TokenRow {
  token: Address
  feed: Address
  maxStaleness: number
  enabled: boolean
}

export interface AdminConfig {
  events: AdminEvent[]
  pending: PendingChange[]
  tokens: TokenRow[]
  targets: { target: Address; allowed: boolean }[]
}

const ZERO = /^0x0{40}$/

/**
 * Tokens, routers and queued changes, rebuilt from the indexer's record of owner actions and then
 * confirmed against the chain (a change only counts as pending while the contract still knows its id).
 * Returns `null` events when the indexer is off; the page then explains how to turn it on.
 */
export function useAdminConfig(network: NetworkConfig) {
  const client = usePublicClient({ chainId: network.chainId })
  const orders = network.ordersAddress
  return useQuery({
    queryKey: ['admin-config', network.key, orders],
    enabled: Boolean(client && orders),
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<AdminConfig | null> => {
      const res = await fetch('/api/admin-events?limit=500')
      if (res.status === 503) return null
      if (!res.ok) throw new Error('Could not load owner history')
      const json = (await res.json()) as { events: { name: string; blockTime: number; txHash: string; args: Record<string, unknown> }[] }
      const events = json.events.map((e) => ({ name: e.name, blockTime: e.blockTime, txHash: e.txHash, args: e.args }))
      const oldestFirst = [...events].reverse()

      const tokenAddrs = new Set<string>()
      const targetAddrs = new Set<string>()
      const queued = new Map<string, PendingChange>()
      for (const e of oldestFirst) {
        const a = e.args
        if (e.name === 'TokenConfigured') tokenAddrs.add(String(a.token))
        else if (e.name === 'SwapTargetSet') targetAddrs.add(String(a.target))
        else if (e.name === 'ConfigQueued') {
          queued.set(String(a.changeId), {
            changeId: a.changeId as `0x${string}`,
            eta: Number(a.eta),
            subject: a.subject as Address,
            feed: a.feed as Address,
            maxStaleness: Number(a.maxStaleness),
            isToken: Boolean(a.isToken),
            allowed: Boolean(a.allowed),
          })
        }
      }

      const base = { address: orders!, abi: ordersAbi } as const
      const tokenList = [...tokenAddrs] as Address[]
      const targetList = [...targetAddrs] as Address[]
      const queuedList = [...queued.values()]
      const [tokenRes, targetRes, etaRes] = await Promise.all([
        client!.multicall({ allowFailure: false, contracts: tokenList.map((t) => ({ ...base, functionName: 'tokenConfigs' as const, args: [t] as const })) }),
        client!.multicall({ allowFailure: false, contracts: targetList.map((t) => ({ ...base, functionName: 'swapTargets' as const, args: [t] as const })) }),
        client!.multicall({ allowFailure: false, contracts: queuedList.map((q) => ({ ...base, functionName: 'pendingConfigEta' as const, args: [q.changeId] as const })) }),
      ])

      const tokens = tokenList.map((token, i) => {
        const c = tokenRes[i]
        return { token, feed: c[0], maxStaleness: Number(c[3]), enabled: !ZERO.test(c[0]) }
      })
      const targets = targetList.map((target, i) => ({ target, allowed: targetRes[i] }))
      const pending = queuedList.filter((_, i) => etaRes[i] > 0n).sort((a, b) => a.eta - b.eta)
      return { events, pending, tokens, targets }
    },
  })
}

export interface OperatorHealth {
  keeper?: { enabled: boolean; running: boolean; keeperAddress: string | null; role?: string; lastTick: number | null; lastError: string | null; executed: number; openOrders?: number; openDcas?: number; notes: string[] }
  gateway?: { providers: { id: string; configured: boolean; breaker: string; consecutiveFailures: number }[] }
  indexer?: { enabled: boolean; running: boolean; lagBlocks: number | string | null; lastError: string | null }
  platformFee?: { bps: number; recipient?: string } | null
  platformFeeProblem?: string
}

/** Detailed backend status. Needs operator access: the admin token, or a direct loopback request in development. */
export function useOperatorHealth(token: string) {
  return useQuery({
    queryKey: ['operator-health', token],
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<OperatorHealth> => {
      const res = await fetch('/api/health', { headers: token ? { authorization: `Bearer ${token}` } : {} })
      if (!res.ok) throw new Error('Backend unavailable')
      return (await res.json()) as OperatorHealth
    },
  })
}
