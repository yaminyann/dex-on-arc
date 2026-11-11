/**
 * Event indexer for ArcTradeOrders. Reads contract logs in block ranges from a stored cursor and
 * writes them idempotently, so a crash, a restart or a re-scan never duplicates rows. Arc has
 * deterministic finality, so there is no reorg handling; if you point this at a chain that can reorg,
 * re-scan a trailing window by lowering the cursor.
 */
import type { Address, Hex } from 'viem'
import { getMeta, setMeta, type Db } from './db'

export interface ChainReader {
  getBlockNumber(): Promise<bigint>
  getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>
  getBlockTime(blockNumber: bigint): Promise<number>
}

export interface RawLog {
  eventName: string
  args: Record<string, unknown>
  blockNumber: bigint
  logIndex: number
  transactionHash: Hex
}

export interface IndexerConfig {
  db: Db
  reader: ChainReader
  chainId: number
  contract: Address
  /** First block to scan when no cursor exists yet. */
  startBlock: bigint
  /** Initial blocks per getLogs call. Halves automatically when the RPC rejects a range. */
  batch?: number
}

/** JSON with bigint as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}

export function eventId(chainId: number, txHash: string, logIndex: number): string {
  return `${chainId}:${txHash.toLowerCase()}:${logIndex}`
}

const cursorKey = (chainId: number, contract: string) => `cursor:${chainId}:${contract.toLowerCase()}`

export async function getCursor(cfg: Pick<IndexerConfig, 'db' | 'chainId' | 'contract'>): Promise<bigint | null> {
  const v = await getMeta(cfg.db, cursorKey(cfg.chainId, cfg.contract))
  return v === null ? null : BigInt(v)
}

export interface IndexResult {
  from: bigint
  to: bigint
  inserted: number
  head: bigint
}

async function insertEvents(cfg: IndexerConfig, logs: RawLog[]): Promise<number> {
  const times = new Map<bigint, number>()
  for (const l of logs) if (!times.has(l.blockNumber)) times.set(l.blockNumber, await cfg.reader.getBlockTime(l.blockNumber))
  let inserted = 0
  for (const l of logs) {
    const owner = typeof l.args.owner === 'string' ? l.args.owner.toLowerCase() : null
    const itemId = l.args.id === undefined ? null : String(l.args.id)
    const res = await cfg.db`insert into events (id, chain_id, contract, block_number, block_time, tx_hash, log_index, name, owner, item_id, args)
      values (${eventId(cfg.chainId, l.transactionHash, l.logIndex)}, ${cfg.chainId}, ${cfg.contract.toLowerCase()}, ${Number(l.blockNumber)}, ${times.get(l.blockNumber) ?? 0},
              ${l.transactionHash.toLowerCase()}, ${l.logIndex}, ${l.eventName}, ${owner}, ${itemId}, ${toJson(l.args)})
      on conflict (id) do nothing`
    inserted += Number((res as { count?: number }).count ?? 0)
  }
  return inserted
}

/** Indexes everything from the cursor up to the chain head. Returns what it did. */
export async function indexOnce(cfg: IndexerConfig): Promise<IndexResult> {
  const head = await cfg.reader.getBlockNumber()
  const cursor = await getCursor(cfg)
  const from = cursor === null ? cfg.startBlock : cursor + 1n
  if (from > head) return { from, to: head, inserted: 0, head }

  let batch = BigInt(cfg.batch ?? 2000)
  let next = from
  let inserted = 0
  while (next <= head) {
    const to = next + batch - 1n > head ? head : next + batch - 1n
    let logs: RawLog[]
    try {
      logs = await cfg.reader.getLogs({ address: cfg.contract, fromBlock: next, toBlock: to })
    } catch (e) {
      // Many RPCs cap the range or result size: shrink and retry, and give up only at a single block.
      if (batch > 1n) {
        batch = batch / 2n
        continue
      }
      throw e
    }
    inserted += await insertEvents(cfg, logs)
    await setMeta(cfg.db, cursorKey(cfg.chainId, cfg.contract), to.toString())
    next = to + 1n
  }
  return { from, to: head, inserted, head }
}
