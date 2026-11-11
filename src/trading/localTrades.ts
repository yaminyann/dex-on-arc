import { useSyncExternalStore } from 'react'
import type { Hex } from 'viem'

/** Market swaps sent from this browser. They are not recorded by the order contract, so we keep the hashes locally and verify receipts when showing them. */
export interface LocalTrade {
  hash: Hex
  chainId: number
  time: number
  side: number
  baseSymbol: string
  sellAmount: string
  sellSymbol: string
  minBuyAmount: string
  buySymbol: string
}

const KEY = 'arc-terminal-market-trades-v1'
const listeners = new Set<() => void>()
let cache: LocalTrade[] | null = null

function read(): LocalTrade[] {
  if (cache) return cache
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '[]') as LocalTrade[]
  } catch {
    cache = []
  }
  return cache
}

export function addLocalTrade(t: LocalTrade) {
  cache = [t, ...read()].slice(0, 100)
  localStorage.setItem(KEY, JSON.stringify(cache))
  listeners.forEach((l) => l())
}

export function useLocalTrades(): LocalTrade[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    read,
  )
}
