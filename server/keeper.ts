/**
 * Built-in keeper. Optional: orders are escrowed on-chain and can be executed by anyone.
 *
 * Env (backend only):
 *   KEEPER_ENABLED=true               start the loop
 *   KEEPER_PRIVATE_KEY=0x...          the operator's own funded key (pays gas, earns the keeper fee)
 *   KEEPER_NETWORK=arc-testnet|arc    which network to watch (default arc-testnet)
 *   KEEPER_INTERVAL_MS=15000          poll interval
 *   KEEPER_SHARD_INDEX / KEEPER_SHARD_COUNT   split work across several keeper instances (default 0 / 1)
 *   KEEPER_MAX_ACTIONS_PER_TICK=25    cap on transactions sent per tick
 *   KEEPER_QUOTE_CONCURRENCY=4        parallel 0x quote requests
 *
 * Scaling model: the keeper keeps an in-memory set of open orders and DCA plans. Each tick it
 * (1) reads only ids it has not seen yet, (2) refreshes the open set with batched Multicall3
 * reads (one eth_call per ~50 orders instead of two per order), (3) acts on at most
 * KEEPER_MAX_ACTIONS_PER_TICK items, and (4) puts failing items on exponential backoff so a
 * stuck order never consumes the budget. State is read directly from the contract (no log
 * scanning), so a restart rebuilds the set from the chain and there is no block-0 backfill.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc, arcTestnet } from 'viem/chains'
import { ordersAbi } from '../src/trading/ordersAbi'
import { getChain } from '../src/onchain-facts'
import { fetchZeroEx, ZEROEX_SUPPORTED_CHAINS } from './zerox'
import harness from '../src/trading/testnet-harness.json'
import { Backoff, chunk, inShard, mapLimit, metrics } from './scale'
import { redactSecrets } from './security'

const testRouterAbi = [
  { type: 'function', name: 'swapExactIn', stateMutability: 'nonpayable', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const

const OPEN = 0
const ACTIVE_DCA = 0
const PAUSED_DCA = 1
const STOP_LIMIT = 3
const TRAILING_STOP = 4
const SELL = 1
const ORDER_BATCH = 50
const MULTICALL_BYTES = 16_384

interface Status {
  enabled: boolean
  running: boolean
  network: string
  keeperAddress: string | null
  lastTick: number | null
  lastError: string | null
  executed: number
  shard: { index: number; count: number }
  openOrders: number
  openDcas: number
  backedOff: number
  notes: string[]
}

const status: Status = {
  enabled: false,
  running: false,
  network: 'arc-testnet',
  keeperAddress: null,
  lastTick: null,
  lastError: null,
  executed: 0,
  shard: { index: 0, count: 1 },
  openOrders: 0,
  openDcas: 0,
  backedOff: 0,
  notes: [],
}

export function keeperStatus(): Status {
  return { ...status, notes: [...status.notes] }
}

function resolveRpc(compassChain: string, fallback: string): string {
  const own = process.env[`RPC_URL_${compassChain}`]
  if (own) return own
  const proxied = (process.env.RPC_PROXY_CHAINS ?? '').split(',').includes(compassChain)
  if (proxied && process.env.RPC_PROXY_BASE_URL) {
    return `${process.env.RPC_PROXY_BASE_URL}/api/rpc/${compassChain}?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
  }
  return fallback
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

interface OrderLite {
  status: number
  orderType: number
  side: number
  expiry: number
  stopActivated: boolean
  base: Address
  maxSlippageBps: number
  amountIn: bigint
  triggerPrice: bigint
  peakPrice: bigint
}

interface DcaLite {
  status: number
  base: Address
  maxSlippageBps: number
  amountPerBuy: bigint
  budgetRemaining: bigint
}

type Check = readonly [boolean, number, bigint, bigint]
type Wallet = ReturnType<typeof createWalletClient>

interface Ctx {
  publicClient: PublicClient
  wallet: Wallet
  address: Address
  chainId: number
  shard: { index: number; count: number }
  maxActions: number
  quoteConcurrency: number
  quoteToken?: Address
  /** Testnet only: the test router stands in for 0x, which does not support Arc Testnet. */
  testRouter?: Address
  orderCursor: bigint
  dcaCursor: bigint
  openOrders: Set<bigint>
  openDcas: Set<bigint>
  /** Ids whose first read failed and must be read again. */
  retryOrders: Set<bigint>
  retryDcas: Set<bigint>
  backoff: Backoff
}

/**
 * Batched reads that tolerate individual failures: a call that reverts yields `undefined` for that
 * slot instead of failing the whole batch, so one bad item cannot stall every other order.
 */
async function multi<T>(ctx: Ctx, calls: { functionName: string; args: readonly unknown[] }[]): Promise<(T | undefined)[]> {
  metrics.keeper.rpcMulticalls += 1
  const res = (await ctx.publicClient.multicall({
    contracts: calls.map((c) => ({ address: ctx.address, abi: ordersAbi, functionName: c.functionName, args: c.args })) as never,
    allowFailure: true,
    batchSize: MULTICALL_BYTES,
  })) as unknown as { status: 'success' | 'failure'; result?: unknown }[]
  return res.map((r) => (r.status === 'success' ? (r.result as T) : undefined))
}

export function startKeeper(): void {
  status.enabled = process.env.KEEPER_ENABLED === 'true'
  if (!status.enabled) {
    status.notes.push('Keeper disabled (KEEPER_ENABLED is not "true").')
    return
  }
  const pk = process.env.KEEPER_PRIVATE_KEY
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    status.lastError = 'KEEPER_PRIVATE_KEY is missing or malformed.'
    return
  }
  const mainnet = process.env.KEEPER_NETWORK === 'arc'
  const chain = mainnet ? arc : arcTestnet
  const compassChain = mainnet ? 'Arc' : 'Arc_Testnet'
  const ordersAddress = (mainnet ? process.env.VITE_ORDERS_ADDRESS_ARC_MAINNET : process.env.VITE_ORDERS_ADDRESS_ARC_TESTNET) as Address | undefined
  const facts = getChain(chain.id)
  if (!ordersAddress || !facts) {
    status.lastError = 'Orders contract address is not configured for this network.'
    return
  }
  const shardCount = envInt('KEEPER_SHARD_COUNT', 1, 1, 256)
  const shardIndex = envInt('KEEPER_SHARD_INDEX', 0, 0, shardCount - 1)
  const transport = http(resolveRpc(compassChain, facts.rpcUrls[0]))
  const account = privateKeyToAccount(pk as Hex)
  const ctx: Ctx = {
    publicClient: createPublicClient({ chain, transport }) as PublicClient,
    wallet: createWalletClient({ account, chain, transport }),
    address: ordersAddress,
    chainId: chain.id,
    shard: { index: shardIndex, count: shardCount },
    maxActions: envInt('KEEPER_MAX_ACTIONS_PER_TICK', 25, 1, 500),
    quoteConcurrency: envInt('KEEPER_QUOTE_CONCURRENCY', 4, 1, 32),
    orderCursor: 1n,
    dcaCursor: 1n,
    openOrders: new Set(),
    openDcas: new Set(),
    retryOrders: new Set(),
    retryDcas: new Set(),
    backoff: new Backoff(),
    testRouter: !mainnet && process.env.KEEPER_USE_TEST_ROUTER !== 'false' ? (harness.router as Address) : undefined,
  }
  status.network = mainnet ? 'arc' : 'arc-testnet'
  status.keeperAddress = account.address
  status.shard = ctx.shard
  status.running = true
  if (ctx.testRouter) {
    status.notes.push('Testnet: swaps are filled through the test router at the public test-feed price.')
  } else if (!ZEROEX_SUPPORTED_CHAINS.has(chain.id)) {
    status.notes.push('0x does not support this chain: only maintenance calls (expire, activate, trail) run, swaps cannot.')
  }

  const interval = envInt('KEEPER_INTERVAL_MS', 15_000, 500, 3_600_000)
  const loop = async () => {
    for (;;) {
      const started = Date.now()
      try {
        await tick(ctx)
        status.lastError = null
      } catch (e) {
        status.lastError = e instanceof Error ? redactSecrets(e.message).slice(0, 300) : 'unknown error'
      }
      metrics.keeper.ticks += 1
      metrics.keeper.lastTickMs = Date.now() - started
      status.lastTick = Date.now()
      status.openOrders = ctx.openOrders.size
      status.openDcas = ctx.openDcas.size
      status.backedOff = ctx.backoff.size
      metrics.keeper.openOrders = ctx.openOrders.size
      metrics.keeper.openDcas = ctx.openDcas.size
      // Sleep the remainder so a slow tick never stacks on the next one.
      await sleep(Math.max(250, interval - (Date.now() - started)))
    }
  }
  void loop()
}

async function send(ctx: Ctx, functionName: 'execute' | 'executeDca' | 'expireOrder' | 'activateStop' | 'pokeTrailing', args: readonly unknown[]): Promise<boolean> {
  try {
    // Simulate first: a revert means the item is not executable right now, which is normal.
    const { request } = await ctx.publicClient.simulateContract({
      address: ctx.address,
      abi: ordersAbi,
      functionName,
      args: args as never,
      account: ctx.wallet.account,
    })
    const hash = await ctx.wallet.writeContract(request as never)
    await ctx.publicClient.waitForTransactionReceipt({ hash })
    return true
  } catch {
    return false
  }
}

interface Candidate {
  fn: 'execute' | 'executeDca'
  id: bigint
  sellToken: Address
  buyToken: Address
  sellAmount: bigint
  slippageBps: number
}

async function tick(ctx: Ctx) {
  const { publicClient, address } = ctx
  const [nextOrderId, nextDcaId] = await Promise.all([
    publicClient.readContract({ address, abi: ordersAbi, functionName: 'nextOrderId' }),
    publicClient.readContract({ address, abi: ordersAbi, functionName: 'nextDcaId' }),
  ])
  ctx.quoteToken ??= await publicClient.readContract({ address, abi: ordersAbi, functionName: 'quote' })
  const quoteToken = ctx.quoteToken
  const now = BigInt(Math.floor(Date.now() / 1000))
  const nowKey = Date.now()

  // 1. Discover new ids (only ones in this shard) and keep the still-open ones.
  // A read that failed (RPC hiccup) is retried next tick instead of being skipped for good.
  const newOrderIds: bigint[] = [...ctx.retryOrders]
  ctx.retryOrders.clear()
  for (let id = ctx.orderCursor; id < nextOrderId; id++) if (inShard(id, ctx.shard.index, ctx.shard.count)) newOrderIds.push(id)
  for (const ids of chunk(newOrderIds, ORDER_BATCH * 2)) {
    const orders = await multi<OrderLite>(ctx, ids.map((id) => ({ functionName: 'getOrder', args: [id] })))
    ids.forEach((id, i) => {
      const o = orders[i]
      if (!o) ctx.retryOrders.add(id)
      else if (o.status === OPEN) ctx.openOrders.add(id)
    })
  }
  ctx.orderCursor = nextOrderId

  const newDcaIds: bigint[] = [...ctx.retryDcas]
  ctx.retryDcas.clear()
  for (let id = ctx.dcaCursor; id < nextDcaId; id++) if (inShard(id, ctx.shard.index, ctx.shard.count)) newDcaIds.push(id)
  for (const ids of chunk(newDcaIds, ORDER_BATCH * 2)) {
    const dcas = await multi<DcaLite>(ctx, ids.map((id) => ({ functionName: 'getDca', args: [id] })))
    ids.forEach((id, i) => {
      const d = dcas[i]
      if (!d) ctx.retryDcas.add(id)
      else if (d.status <= PAUSED_DCA) ctx.openDcas.add(id)
    })
  }
  ctx.dcaCursor = nextDcaId

  const maintenance: { fn: 'expireOrder' | 'activateStop' | 'pokeTrailing'; id: bigint }[] = []
  const candidates: Candidate[] = []

  // 2. Refresh open orders in batches: [getOrder, checkOrder] per id.
  const dueOrders = [...ctx.openOrders].filter((id) => {
    const ready = ctx.backoff.ready(`o${id}`, nowKey)
    if (!ready) metrics.keeper.skippedBackoff += 1
    return ready
  })
  for (const ids of chunk(dueOrders, ORDER_BATCH)) {
    const res = await multi<OrderLite | Check>(ctx, ids.flatMap((id) => [{ functionName: 'getOrder', args: [id] }, { functionName: 'checkOrder', args: [id] }]))
    ids.forEach((id, i) => {
      const o = res[i * 2] as OrderLite | undefined
      const checked = res[i * 2 + 1] as Check | undefined
      if (!o || !checked) {
        // Unreadable right now: back off this item only and carry on with the rest.
        ctx.backoff.fail(`o${id}`)
        return
      }
      const [executable, , price18] = checked
      if (o.status !== OPEN) {
        ctx.openOrders.delete(id)
        ctx.backoff.clear(`o${id}`)
        return
      }
      if (now >= BigInt(o.expiry)) {
        maintenance.push({ fn: 'expireOrder', id })
        return
      }
      if (o.orderType === TRAILING_STOP && price18 > o.peakPrice) maintenance.push({ fn: 'pokeTrailing', id })
      if (o.orderType === STOP_LIMIT && !o.stopActivated && price18 > 0n && price18 <= o.triggerPrice) maintenance.push({ fn: 'activateStop', id })
      if (executable) {
        const sell = o.side === SELL
        candidates.push({ fn: 'execute', id, sellToken: sell ? o.base : quoteToken, buyToken: sell ? quoteToken : o.base, sellAmount: o.amountIn, slippageBps: o.maxSlippageBps })
      }
    })
  }

  // 3. Refresh open DCA plans.
  const dueDcas = [...ctx.openDcas].filter((id) => {
    const ready = ctx.backoff.ready(`d${id}`, nowKey)
    if (!ready) metrics.keeper.skippedBackoff += 1
    return ready
  })
  for (const ids of chunk(dueDcas, ORDER_BATCH)) {
    const res = await multi<DcaLite | Check>(ctx, ids.flatMap((id) => [{ functionName: 'getDca', args: [id] }, { functionName: 'checkDca', args: [id] }]))
    ids.forEach((id, i) => {
      const d = res[i * 2] as DcaLite | undefined
      const checked = res[i * 2 + 1] as Check | undefined
      if (!d || !checked) {
        ctx.backoff.fail(`d${id}`)
        return
      }
      const [executable] = checked
      if (d.status > PAUSED_DCA) {
        ctx.openDcas.delete(id)
        ctx.backoff.clear(`d${id}`)
        return
      }
      if (d.status !== ACTIVE_DCA || !executable) return
      const amountIn = d.amountPerBuy < d.budgetRemaining ? d.amountPerBuy : d.budgetRemaining
      candidates.push({ fn: 'executeDca', id, sellToken: quoteToken, buyToken: d.base, sellAmount: amountIn, slippageBps: d.maxSlippageBps })
    })
  }

  // 4. Act, bounded per tick. Maintenance is cheap and unblocks orders, so it goes first.
  let budget = ctx.maxActions
  for (const m of maintenance) {
    if (budget-- <= 0) return
    const ok = await send(ctx, m.fn, [m.id])
    metrics.keeper.maintenanceCalls += 1
    if (ok && m.fn === 'expireOrder') ctx.openOrders.delete(m.id)
  }
  if ((!ZEROEX_SUPPORTED_CHAINS.has(ctx.chainId) && !ctx.testRouter) || candidates.length === 0) return

  const batch = candidates.slice(0, Math.max(0, budget))
  const quotes = await mapLimit(batch, ctx.quoteConcurrency, async (c) => {
    try {
      if (ctx.testRouter) {
        const data = encodeFunctionData({ abi: testRouterAbi, functionName: 'swapExactIn', args: [c.sellToken, c.buyToken, c.sellAmount] })
        return { liquidityAvailable: true, transaction: { to: ctx.testRouter, data } } as { liquidityAvailable?: boolean; transaction?: { to: Address; data: Hex } }
      }
      const q = await fetchZeroEx('quote', {
        chainId: ctx.chainId,
        sellToken: c.sellToken,
        buyToken: c.buyToken,
        sellAmount: c.sellAmount.toString(),
        taker: address,
        slippageBps: Math.min(c.slippageBps, 100),
      })
      return q.body as { liquidityAvailable?: boolean; transaction?: { to: Address; data: Hex } }
    } catch {
      return null
    }
  })

  const allowed = new Map<string, boolean>()
  for (let i = 0; i < batch.length; i++) {
    const c = batch[i]
    const key = `${c.fn === 'execute' ? 'o' : 'd'}${c.id}`
    const tx = quotes[i]?.transaction
    if (!quotes[i]?.liquidityAvailable || !tx) {
      ctx.backoff.fail(key)
      continue
    }
    if (!allowed.has(tx.to)) {
      allowed.set(tx.to, await publicClient.readContract({ address, abi: ordersAbi, functionName: 'swapTargets', args: [tx.to] }))
    }
    if (!allowed.get(tx.to)) {
      status.lastError = `0x target ${tx.to} is not allowlisted on the orders contract.`
      ctx.backoff.fail(key)
      continue
    }
    if (await send(ctx, c.fn, [c.id, tx.to, tx.data])) {
      status.executed += 1
      metrics.keeper.executed += 1
      ctx.backoff.clear(key)
    } else {
      metrics.keeper.failedExecutions += 1
      ctx.backoff.fail(key)
    }
  }
}
