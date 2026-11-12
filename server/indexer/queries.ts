import type { Db } from './db'

export interface HistoryRow {
  id: string
  chainId: number
  blockNumber: number
  blockTime: number
  txHash: string
  logIndex: number
  name: string
  owner: string | null
  itemId: string | null
  args: unknown
}

export interface SwapRow {
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

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function clampLimit(raw: string | null, fallback = 50, max = 200): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback
}

export function validOwner(owner: string | null): owner is string {
  return Boolean(owner && ADDRESS_RE.test(owner))
}

type EventRow = {
  id: string
  chain_id: number
  block_number: number
  block_time: number
  tx_hash: string
  log_index: number
  name: string
  owner: string | null
  item_id: string | null
  args: string
}

/** Newest first. `before` is an exclusive block number for paging. */
export async function historyFor(db: Db, q: { chainId: number; owner: string; limit: number; before?: number }): Promise<HistoryRow[]> {
  const owner = q.owner.toLowerCase()
  const rows = (q.before
    ? await db`select * from events where chain_id = ${q.chainId} and owner = ${owner} and block_number < ${q.before} order by block_number desc, log_index desc limit ${q.limit}`
    : await db`select * from events where chain_id = ${q.chainId} and owner = ${owner} order by block_number desc, log_index desc limit ${q.limit}`) as EventRow[]
  return rows.map((r) => ({
    id: r.id,
    chainId: r.chain_id,
    blockNumber: r.block_number,
    blockTime: r.block_time,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    name: r.name,
    owner: r.owner,
    itemId: r.item_id,
    args: JSON.parse(r.args) as unknown,
  }))
}

type SwapDbRow = {
  chain_id: number
  tx_hash: string
  owner: string
  target: string
  sell_token: string
  sell_amount: string
  buy_token: string
  buy_amount: string
  block_number: number
  block_time: number
}

export async function swapsFor(db: Db, q: { chainId: number; owner: string; limit: number }): Promise<SwapRow[]> {
  const rows = (await db`select * from swaps where chain_id = ${q.chainId} and owner = ${q.owner.toLowerCase()} order by block_number desc limit ${q.limit}`) as SwapDbRow[]
  return rows.map((r) => ({
    chainId: r.chain_id,
    txHash: r.tx_hash,
    owner: r.owner,
    target: r.target,
    sellToken: r.sell_token,
    sellAmount: r.sell_amount,
    buyToken: r.buy_token,
    buyAmount: r.buy_amount,
    blockNumber: r.block_number,
    blockTime: r.block_time,
  }))
}

export async function eventCounts(db: Db, chainId: number): Promise<Record<string, number>> {
  const rows = (await db`select name, count(*) as n from events where chain_id = ${chainId} group by name`) as { name: string; n: number | string }[]
  return Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]))
}

export async function swapCount(db: Db, chainId: number): Promise<number> {
  const rows = (await db`select count(*) as n from swaps where chain_id = ${chainId}`) as { n: number | string }[]
  return Number(rows[0]?.n ?? 0)
}

/** Owner actions that change how the contract behaves. Public chain data, newest first. */
const ADMIN_EVENT_NAMES = ['ConfigQueued', 'ConfigCancelled', 'TokenConfigured', 'SwapTargetSet', 'KeeperFeeSet', 'MinOrderQuoteSet', 'Paused', 'Unpaused', 'OwnershipTransferStarted', 'OwnershipTransferred'] as const

export async function adminEventsFor(db: Db, q: { chainId: number; limit: number }): Promise<HistoryRow[]> {
  const rows = (await db`select * from events where chain_id = ${q.chainId} and (name = 'ConfigQueued' or name = 'ConfigCancelled' or name = 'TokenConfigured' or name = 'SwapTargetSet' or name = 'KeeperFeeSet' or name = 'MinOrderQuoteSet' or name = 'Paused' or name = 'Unpaused' or name = 'OwnershipTransferStarted' or name = 'OwnershipTransferred') order by block_number desc, log_index desc limit ${q.limit}`) as EventRow[]
  return rows.map((r) => ({
    id: r.id,
    chainId: r.chain_id,
    blockNumber: r.block_number,
    blockTime: r.block_time,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    name: r.name,
    owner: r.owner,
    itemId: r.item_id,
    args: JSON.parse(r.args) as unknown,
  }))
}

export { ADMIN_EVENT_NAMES }
