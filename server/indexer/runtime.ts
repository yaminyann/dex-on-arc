/**
 * Starts the indexer from environment and exposes its status. Off unless INDEXER_ENABLED=true.
 *
 *   INDEXER_ENABLED=true
 *   INDEXER_NETWORK=arc-testnet|arc     which chain to index (default arc-testnet)
 *   INDEXER_INTERVAL_MS=5000            poll interval
 *   INDEXER_START_BLOCK=<n>             first block when there is no cursor (default: the deployment block)
 *   DATABASE_URL=sqlite://./data/indexer.db | postgres://...
 */
import { parseEventLogs, type Address, type Hex, type PublicClient } from 'viem'
import { arc, arcTestnet } from 'viem/chains'
import { publicClientFor } from '../rpc'
import { redactSecrets } from '../security'
import { alerter } from '../alerts'
import { openDb, type Db } from './db'
import { getCursor, indexOnce, type ChainReader, type RawLog } from './indexer'
import type { TxReader } from './swaps'
import { ordersAbi } from '../../src/trading/ordersAbi'

export interface IndexerStatus {
  enabled: boolean
  running: boolean
  chainId: number | null
  contract: string | null
  cursor: string | null
  head: string | null
  lagBlocks: number | null
  indexedEvents: number
  lastRunAt: number | null
  lastError: string | null
}

const status: IndexerStatus = { enabled: false, running: false, chainId: null, contract: null, cursor: null, head: null, lagBlocks: null, indexedEvents: 0, lastRunAt: null, lastError: null }

export function indexerStatus(): IndexerStatus {
  return { ...status }
}

let dbRef: Db | null = null
let chainRef: number | null = null
let txReader: TxReader | null = null

export function indexerDb(): { db: Db; chainId: number; reader: TxReader } | null {
  return dbRef && chainRef !== null && txReader ? { db: dbRef, chainId: chainRef, reader: txReader } : null
}

export function viemReaders(client: PublicClient): { chain: ChainReader; tx: TxReader } {
  const times = new Map<bigint, number>()
  const blockTime = async (n: bigint) => {
    const hit = times.get(n)
    if (hit !== undefined) return hit
    const b = await client.getBlock({ blockNumber: n })
    const t = Number(b.timestamp)
    times.set(n, t)
    if (times.size > 5000) times.delete(times.keys().next().value as bigint)
    return t
  }
  return {
    chain: {
      getBlockNumber: () => client.getBlockNumber(),
      getBlockTime: blockTime,
      getLogs: async ({ address, fromBlock, toBlock }) => {
        // No topic filter: the contract emits only its own events, and a filter listing every event
        // topic exceeds some RPCs' request limits. Logs are decoded locally instead.
        const raw = await client.getLogs({ address, fromBlock, toBlock })
        const logs = parseEventLogs({ abi: ordersAbi, logs: raw, strict: false })
        return (logs as unknown as { eventName: string; args: Record<string, unknown>; blockNumber: bigint; logIndex: number; transactionHash: Hex }[]).map(
          (l): RawLog => ({ eventName: l.eventName, args: l.args ?? {}, blockNumber: l.blockNumber, logIndex: l.logIndex, transactionHash: l.transactionHash }),
        )
      },
    },
    tx: {
      getBlockTime: blockTime,
      getTransactionReceipt: async (hash) => {
        try {
          const r = await client.getTransactionReceipt({ hash })
          return { status: r.status, blockNumber: r.blockNumber, from: r.from, to: r.to, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) }
        } catch {
          return null
        }
      },
    },
  }
}

export async function startIndexer(): Promise<void> {
  status.enabled = process.env.INDEXER_ENABLED === 'true'
  if (!status.enabled) return
  const mainnet = process.env.INDEXER_NETWORK === 'arc'
  const chain = mainnet ? arc : arcTestnet
  const contract = (mainnet ? process.env.VITE_ORDERS_ADDRESS_ARC_MAINNET : process.env.VITE_ORDERS_ADDRESS_ARC_TESTNET) as Address | undefined
  if (!contract) {
    status.lastError = 'Orders contract address is not configured for this network.'
    return
  }
  try {
    const client = publicClientFor(chain.id)
    const readers = viemReaders(client)
    const db = await openDb()
    dbRef = db
    chainRef = chain.id
    txReader = readers.tx
    status.chainId = chain.id
    status.contract = contract

    let startBlock = process.env.INDEXER_START_BLOCK ? BigInt(process.env.INDEXER_START_BLOCK) : null
    if (startBlock === null) {
      const deployTx = (mainnet ? process.env.VITE_ORDERS_DEPLOY_TX_ARC_MAINNET : process.env.VITE_ORDERS_DEPLOY_TX_ARC_TESTNET) as Hex | undefined
      if (deployTx) startBlock = (await client.getTransactionReceipt({ hash: deployTx }).catch(() => null))?.blockNumber ?? null
    }
    // Without a deployment block, start from a bounded recent window rather than block 0.
    const startFrom = startBlock ?? (await client.getBlockNumber()) - 50_000n
    const cfg = { db, reader: readers.chain, chainId: chain.id, contract, startBlock: startFrom < 0n ? 0n : startFrom }
    const interval = Math.max(500, Number(process.env.INDEXER_INTERVAL_MS ?? 5000) || 5000)
    status.running = true
    const loop = async () => {
      for (;;) {
        try {
          const r = await indexOnce(cfg)
          status.indexedEvents += r.inserted
          status.head = r.head.toString()
          status.cursor = (await getCursor(cfg))?.toString() ?? null
          status.lagBlocks = status.cursor === null ? null : Number(r.head - BigInt(status.cursor))
          status.lastError = null
          status.lastRunAt = Date.now()
          void alerter.resolve('indexer')
        } catch (e) {
          status.lastError = e instanceof Error ? redactSecrets(e.message).slice(0, 300) : 'unknown error'
          void alerter.raise('indexer', `indexer is failing: ${status.lastError}`)
        }
        await new Promise((res) => setTimeout(res, interval))
      }
    }
    void loop()
  } catch (e) {
    status.lastError = e instanceof Error ? redactSecrets(e.message).slice(0, 300) : 'unknown error'
  }
}
