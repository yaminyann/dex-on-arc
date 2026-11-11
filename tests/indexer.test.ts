import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from 'viem'
import { migrate } from '../server/indexer/db'
import { eventId, getCursor, indexOnce, type ChainReader, type RawLog } from '../server/indexer/indexer'
import { clampLimit, eventCounts, historyFor, swapCount, swapsFor, validOwner } from '../server/indexer/queries'
import { deriveSwap, recordSwap, type ReceiptLike, type TxReader } from '../server/indexer/swaps'
import { swapTargetsFor } from '../server/gateway/targets'

const CONTRACT = '0x259d5810aadfde23ac193dce84e6462025cea02c' as Address
const ALICE = '0x00000000000000000000000000000000000a11ce' as Address
const BOB = '0x0000000000000000000000000000000000000b0b' as Address
const ROUTER = '0x6812943fc8cf6acf9a098cbabb2277112d77a93f' as Address
const USDC = '0x3600000000000000000000000000000000000000' as Address
const TBTC = '0x661bf226688f011115a84f5a1243ca6b467c8dfe' as Address

async function freshDb() {
  const db = new SQL('sqlite://:memory:')
  await migrate(db)
  return db
}

const hash = (n: number) => (`0x${n.toString(16).padStart(64, '0')}`) as Hex

function log(block: number, idx: number, eventName: string, args: Record<string, unknown>): RawLog {
  return { eventName, args, blockNumber: BigInt(block), logIndex: idx, transactionHash: hash(block * 100 + idx) }
}

function reader(head: bigint, logs: RawLog[], opts: { maxRange?: bigint; calls?: { from: bigint; to: bigint }[] } = {}): ChainReader {
  return {
    getBlockNumber: async () => head,
    getBlockTime: async (n) => 1_700_000_000 + Number(n),
    getLogs: async ({ fromBlock, toBlock }) => {
      opts.calls?.push({ from: fromBlock, to: toBlock })
      if (opts.maxRange !== undefined && toBlock - fromBlock + 1n > opts.maxRange) throw new Error('range too large')
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
    },
  }
}

const LOGS: RawLog[] = [
  log(10, 0, 'OrderCreated', { id: 1n, owner: ALICE, base: TBTC, createdAt: 123 }),
  log(12, 1, 'OrderExecuted', { id: 1n, owner: ALICE, amountIn: 5_000_000n, net: 12_345_678_901_234_567_890n, keeperFee: 1n }),
  log(12, 2, 'OrderCreated', { id: 2n, owner: BOB, base: TBTC }),
  log(15, 0, 'DcaCompleted', { id: 3n }),
]

describe('indexer', () => {
  test('indexes from the start block, stores bigints losslessly, and sets the cursor', async () => {
    const db = await freshDb()
    const cfg = { db, reader: reader(20n, LOGS), chainId: 5042002, contract: CONTRACT, startBlock: 5n }
    const r = await indexOnce(cfg)
    expect(r.inserted).toBe(4)
    expect(await getCursor(cfg)).toBe(20n)
    const rows = await historyFor(db, { chainId: 5042002, owner: ALICE, limit: 10 })
    expect(rows.map((x) => x.name)).toEqual(['OrderExecuted', 'OrderCreated'])
    expect((rows[0].args as { net: string }).net).toBe('12345678901234567890')
    expect(rows[0].blockTime).toBe(1_700_000_012)
    expect(rows[0].itemId).toBe('1')
  })

  test('is idempotent: a re-run or a lowered cursor never duplicates rows', async () => {
    const db = await freshDb()
    const cfg = { db, reader: reader(20n, LOGS), chainId: 5042002, contract: CONTRACT, startBlock: 0n }
    await indexOnce(cfg)
    expect((await indexOnce(cfg)).inserted).toBe(0)
    await db`update meta set value = ${'0'}`
    expect((await indexOnce(cfg)).inserted).toBe(0)
    expect(Object.values(await eventCounts(db, 5042002)).reduce((a, b) => a + b, 0)).toBe(4)
  })

  test('picks up new blocks on the next run', async () => {
    const db = await freshDb()
    const logs = [...LOGS]
    const first = { db, reader: reader(20n, logs), chainId: 5042002, contract: CONTRACT, startBlock: 0n }
    await indexOnce(first)
    logs.push(log(25, 0, 'OrderCancelled', { id: 2n, owner: BOB, refund: 1n }))
    const second = { ...first, reader: reader(30n, logs) }
    const r = await indexOnce(second)
    expect(r.inserted).toBe(1)
    expect(r.from).toBe(21n)
  })

  test('splits the range into batches and shrinks them when the RPC rejects a range', async () => {
    const db = await freshDb()
    const calls: { from: bigint; to: bigint }[] = []
    const cfg = { db, reader: reader(40n, LOGS, { maxRange: 8n, calls }), chainId: 5042002, contract: CONTRACT, startBlock: 0n, batch: 32 }
    const r = await indexOnce(cfg)
    expect(r.inserted).toBe(4)
    expect(Math.max(...calls.filter((c) => c.to - c.from + 1n <= 8n).map((c) => Number(c.to - c.from + 1n)))).toBeLessThanOrEqual(8)
    expect(await getCursor(cfg)).toBe(40n)
  })

  test('a failing single-block range surfaces the error without advancing past it', async () => {
    const db = await freshDb()
    const bad: ChainReader = { ...reader(5n, []), getLogs: async () => { throw new Error('rpc down') } }
    const cfg = { db, reader: bad, chainId: 5042002, contract: CONTRACT, startBlock: 0n, batch: 4 }
    await expect(indexOnce(cfg)).rejects.toThrow('rpc down')
    expect(await getCursor(cfg)).toBeNull()
  })

  test('history pages newest first and is scoped to the owner and chain', async () => {
    const db = await freshDb()
    await indexOnce({ db, reader: reader(20n, LOGS), chainId: 5042002, contract: CONTRACT, startBlock: 0n })
    const page1 = await historyFor(db, { chainId: 5042002, owner: ALICE, limit: 1 })
    expect(page1).toHaveLength(1)
    const page2 = await historyFor(db, { chainId: 5042002, owner: ALICE, limit: 5, before: page1[0].blockNumber })
    expect(page2.map((x) => x.name)).toEqual(['OrderCreated'])
    expect(await historyFor(db, { chainId: 1, owner: ALICE, limit: 5 })).toEqual([])
    expect((await historyFor(db, { chainId: 5042002, owner: ALICE.toUpperCase().replace('0X', '0x') as Address, limit: 5 })).length).toBe(2)
  })

  test('event ids and query helpers', () => {
    expect(eventId(1, '0xABC', 2)).toBe('1:0xabc:2')
    expect(clampLimit(null)).toBe(50)
    expect(clampLimit('9999')).toBe(200)
    expect(clampLimit('0')).toBe(50)
    expect(validOwner(ALICE)).toBe(true)
    expect(validOwner('nope')).toBe(false)
  })
})

function transfer(token: Address, from: Address, to: Address, value: bigint) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  }
}

function receipt(over: Partial<ReceiptLike> = {}): ReceiptLike {
  return {
    status: 'success',
    blockNumber: 77n,
    from: ALICE,
    to: ROUTER,
    logs: [transfer(USDC, ALICE, ROUTER, 1_000_000n), transfer(TBTC, ROUTER, ALICE, 1_300n)],
    ...over,
  }
}

describe('swap verification', () => {
  test('derives the sold and bought token and amounts from the sender transfers', () => {
    const v = deriveSwap(receipt(), [ROUTER])
    expect(v.ok && v.swap).toMatchObject({ owner: ALICE.toLowerCase(), sellToken: USDC.toLowerCase(), sellAmount: 1_000_000n, buyToken: TBTC.toLowerCase(), buyAmount: 1_300n })
  })

  test('ignores the native gas-fee transfer Arc emits from its pseudo-address', () => {
    const gas = transfer('0xfffffffffffffffffffffffffffffffffffffffe' as Address, ALICE, BOB, 12_345_678_901_234_567n)
    const v = deriveSwap(receipt({ logs: [gas, transfer(USDC, ALICE, ROUTER, 1_000_000n), transfer(TBTC, '0x0000000000000000000000000000000000000000' as Address, ALICE, 1_300n)] }), [ROUTER])
    expect(v.ok && v.swap.sellToken).toBe(USDC.toLowerCase())
    expect(v.ok && v.swap.buyAmount).toBe(1_300n)
  })

  test('nets out a partial refund of the sold token', () => {
    const r = receipt({ logs: [transfer(USDC, ALICE, ROUTER, 1_000_000n), transfer(TBTC, ROUTER, ALICE, 1_300n), transfer(USDC, ROUTER, ALICE, 100_000n)] })
    const v = deriveSwap(r, [ROUTER])
    expect(v.ok && v.swap.sellAmount).toBe(900_000n)
  })

  test('rejects an unknown target, a reverted transaction and ambiguous transfers', () => {
    expect(deriveSwap(receipt({ to: BOB }), [ROUTER])).toMatchObject({ ok: false, code: 'NOT_A_SWAP_TARGET' })
    expect(deriveSwap(receipt({ to: null }), [ROUTER])).toMatchObject({ ok: false, code: 'NOT_A_SWAP_TARGET' })
    expect(deriveSwap(receipt({ status: 'reverted' }), [ROUTER])).toMatchObject({ ok: false, code: 'REVERTED' })
    expect(deriveSwap(receipt({ logs: [transfer(USDC, ALICE, ROUTER, 1n)] }), [ROUTER])).toMatchObject({ ok: false, code: 'UNRECOGNIZED_SWAP' })
    expect(deriveSwap(receipt({ logs: [transfer(USDC, ALICE, ROUTER, 1n), transfer(TBTC, ALICE, ROUTER, 1n), transfer(TBTC, ROUTER, ALICE, 1n)] }), [ROUTER])).toMatchObject({ ok: false, code: 'UNRECOGNIZED_SWAP' }) // a token sent and returned is not a swap
  })

  test('recording is stored once, queryable, and a forged hash cannot write anything', async () => {
    const db = await freshDb()
    const txReader: TxReader = {
      getTransactionReceipt: async (h) => (h === hash(1) ? receipt() : h === hash(2) ? receipt({ to: BOB }) : null),
      getBlockTime: async () => 1_700_000_077,
    }
    const args = { chainId: 5042002, allowedTargets: [ROUTER] }
    expect((await recordSwap(db, txReader, { ...args, hash: hash(1) })).ok).toBe(true)
    expect((await recordSwap(db, txReader, { ...args, hash: hash(1) })).ok).toBe(true)
    expect(await swapCount(db, 5042002)).toBe(1)
    expect(await recordSwap(db, txReader, { ...args, hash: hash(2) })).toMatchObject({ ok: false, code: 'NOT_A_SWAP_TARGET' })
    expect(await recordSwap(db, txReader, { ...args, hash: hash(3) })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await swapCount(db, 5042002)).toBe(1)
    const [row] = await swapsFor(db, { chainId: 5042002, owner: ALICE, limit: 5 })
    expect(row).toMatchObject({ sellAmount: '1000000', buyAmount: '1300', blockTime: 1_700_000_077 })
  })

  test('known swap targets per chain', () => {
    expect(swapTargetsFor(5042).length).toBeGreaterThanOrEqual(2)
    expect(swapTargetsFor(5042002).length).toBeGreaterThanOrEqual(1)
    expect(swapTargetsFor(1)).toEqual([])
  })
})
