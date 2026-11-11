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
import { createPublicClient, createWalletClient, erc20Abi, parseEventLogs, webSocket, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc, arcTestnet } from 'viem/chains'
import { ordersAbi } from '../src/trading/ordersAbi'
import { getChain } from '../src/onchain-facts'
import { gateway } from './gateway/instance'
import { resolveRpcUrls, transportFor } from './rpc'
import { alerter } from './alerts'
import { applyGasFloor, expectedFeeUsdc6, isProfitable, loadKeeperKey, NonceTracker, StandbyGate, type ProfitPolicy } from './keeper-core'
import { Backoff, chunk, inShard, mapLimit, metrics } from './scale'
import { redactSecrets } from './security'

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
  role: 'primary' | 'standby'
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
  role: 'primary',
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
  orderCursor: bigint
  dcaCursor: bigint
  openOrders: Set<bigint>
  openDcas: Set<bigint>
  /** Ids whose first read failed and must be read again. */
  retryOrders: Set<bigint>
  retryDcas: Set<bigint>
  backoff: Backoff
  role: 'primary' | 'standby'
  standby: StandbyGate
  profit: ProfitPolicy
  gasFloorWei: bigint
  usdc: Address
  feeBps: number
  /** True when the contract has executeMany (v2) and batching is not disabled. Unknown until the first check. */
  batch: boolean | undefined
  batchMax: number
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
  const loaded = loadKeeperKey()
  if (!loaded.key) {
    status.lastError = loaded.error ?? 'Keeper private key is missing or malformed.'
    return
  }
  const pk = loaded.key
  const mainnet = process.env.KEEPER_NETWORK === 'arc'
  const chain = mainnet ? arc : arcTestnet
  const compassChain = mainnet ? 'Arc' : 'Arc_Testnet'
  const ordersAddress = (mainnet ? process.env.VITE_ORDERS_ADDRESS_ARC_MAINNET : process.env.VITE_ORDERS_ADDRESS_ARC_TESTNET) as Address | undefined
  const facts = getChain(chain.id)
  if (!ordersAddress || !facts) {
    status.lastError = 'Orders contract address is not configured for this network.'
    return
  }
  const role = process.env.KEEPER_ROLE === 'standby' ? 'standby' : 'primary'
  // A standby watches every item; sharding only applies to primaries.
  const shardCount = role === 'standby' ? 1 : envInt('KEEPER_SHARD_COUNT', 1, 1, 256)
  const shardIndex = role === 'standby' ? 0 : envInt('KEEPER_SHARD_INDEX', 0, 0, shardCount - 1)
  const transport = transportFor(resolveRpcUrls(compassChain, facts.rpcUrls))
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
    role,
    standby: new StandbyGate(envInt('KEEPER_STANDBY_GRACE_MS', 90_000, 1000, 3_600_000)),
    // Testnet fees are worth nothing, so profitability only gates mainnet unless set explicitly.
    profit: {
      require: (process.env.KEEPER_REQUIRE_PROFIT ?? (mainnet ? 'true' : 'false')) !== 'false',
      marginBps: envInt('KEEPER_PROFIT_MARGIN_BPS', 0, 0, 100_000),
      minFeeUsdc6: BigInt(envInt('KEEPER_MIN_FEE_USDC_MICRO', 0, 0, 1_000_000_000)),
    },
    gasFloorWei: BigInt(envInt('KEEPER_MIN_GAS_PRICE_GWEI', 20, 0, 10_000)) * 1_000_000_000n,
    usdc: (facts.usdc?.address ?? '0x3600000000000000000000000000000000000000') as Address,
    feeBps: 10,
    batch: process.env.KEEPER_USE_BATCH === 'false' ? false : undefined,
    batchMax: envInt('KEEPER_BATCH_MAX', 10, 2, 50),
  }
  status.network = mainnet ? 'arc' : 'arc-testnet'
  status.keeperAddress = account.address
  status.role = role
  status.shard = ctx.shard
  status.running = true
  if (role === 'standby') status.notes.push(`Standby: acts on an item only after it stayed actionable for ${envInt('KEEPER_STANDBY_GRACE_MS', 90_000, 1000, 3_600_000)} ms.`)
  if (!gateway.supportsChain(chain.id)) {
    status.notes.push('No swap provider supports this chain: only maintenance calls (expire, activate, trail) run, swaps cannot.')
  } else if (!mainnet) {
    status.notes.push(`Testnet: swaps are filled through the test routers (${gateway.providers.filter((p) => p.supports(chain.id)).map((p) => p.id).join(', ')}) at the public test-feed price.`)
  }

  const interval = envInt('KEEPER_INTERVAL_MS', 15_000, 500, 3_600_000)
  const minTickGap = envInt('KEEPER_MIN_TICK_MS', 1000, 250, 60_000)

  // Event wake: a new order or DCA plan ends the idle sleep early instead of waiting out the interval.
  // Polling stays as the fallback, so a dropped socket only costs latency, never correctness.
  let wakeIdle: (() => void) | null = null
  const idle = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        wakeIdle = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      wakeIdle = done
    })
  const wsUrl = process.env.KEEPER_WS_URL
  if (wsUrl) {
    status.notes.push('Event wake enabled (WebSocket). Polling remains the fallback.')
    startEventWake(ctx, chain, wsUrl, () => {
      metrics.keeper.wakeups += 1
      wakeIdle?.()
    })
  }
  const loop = async () => {
    for (;;) {
      const started = Date.now()
      try {
        await tick(ctx)
        status.lastError = null
        metrics.keeper.consecutiveTickErrors = 0
        metrics.keeper.lastOkTickAt = Date.now()
      } catch (e) {
        status.lastError = e instanceof Error ? redactSecrets(e.message).slice(0, 300) : 'unknown error'
        metrics.keeper.consecutiveTickErrors += 1
      }
      void alerter.set('keeper:ticks', metrics.keeper.consecutiveTickErrors >= 3, `keeper ticks are failing (${metrics.keeper.consecutiveTickErrors} in a row): ${status.lastError ?? ''}`)
      const minBalance = Number(process.env.KEEPER_MIN_BALANCE_USDC ?? 1)
      void alerter.set('keeper:balance', metrics.keeper.balanceUsdc >= 0 && metrics.keeper.balanceUsdc < minBalance, `keeper wallet is low: ${metrics.keeper.balanceUsdc} USDC (minimum ${minBalance}). Fund ${account.address}.`)
      metrics.keeper.ticks += 1
      metrics.keeper.lastTickMs = Date.now() - started
      status.lastTick = Date.now()
      status.openOrders = ctx.openOrders.size
      status.openDcas = ctx.openDcas.size
      status.backedOff = ctx.backoff.size
      metrics.keeper.openOrders = ctx.openOrders.size
      metrics.keeper.openDcas = ctx.openDcas.size
      // Sleep the remainder so a slow tick never stacks on the next one.
      const elapsed = Date.now() - started
      if (elapsed < minTickGap) await sleep(minTickGap - elapsed)
      await idle(Math.max(0, interval - (Date.now() - started)))
    }
  }
  void loop()
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
  ctx.feeBps = Number(await publicClient.readContract({ address, abi: ordersAbi, functionName: 'keeperFeeBps' }))
  const balance = await publicClient.readContract({ address: ctx.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.wallet.account!.address] }).catch(() => null)
  if (balance !== null) metrics.keeper.balanceUsdc = Number(balance) / 1e6
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
  // A standby keeper only acts on items that stayed actionable past its grace period.
  const keyOf = (c: Candidate) => `${c.fn === 'execute' ? 'o' : 'd'}${c.id}`
  const mKey = (m: { fn: string; id: bigint }) => `m:${m.fn}:${m.id}`
  let acting = { maintenance, candidates }
  if (ctx.role === 'standby') {
    const ready = ctx.standby.observe([...maintenance.map(mKey), ...candidates.map(keyOf)], nowKey)
    acting = { maintenance: maintenance.filter((m) => ready.has(mKey(m))), candidates: candidates.filter((c) => ready.has(keyOf(c))) }
    metrics.keeper.standbyWaiting = ctx.standby.waiting - ready.size
  }

  const jobs: Job[] = acting.maintenance.slice(0, ctx.maxActions).map((m) => ({ fn: m.fn, args: [m.id], key: mKey(m), maintenance: true }))

  const swapsPossible = gateway.supportsChain(ctx.chainId)
  if (swapsPossible && acting.candidates.length > 0) {
    const batch = acting.candidates.slice(0, Math.max(0, ctx.maxActions - jobs.length))
    const allowed = new Map<string, boolean>()
    const isAllowed = async (to: string) => {
      if (!allowed.has(to)) allowed.set(to, await publicClient.readContract({ address, abi: ordersAbi, functionName: 'swapTargets', args: [to as Address] }))
      return allowed.get(to) === true
    }
    const built = await mapLimit(batch, ctx.quoteConcurrency, async (c): Promise<Job | null> => {
      const key = keyOf(c)
      try {
        const { ranked } = await gateway.rank('quote', { chainId: ctx.chainId, sellToken: c.sellToken, buyToken: c.buyToken, sellAmount: c.sellAmount.toString(), taker: address, slippageBps: Math.min(c.slippageBps, 100) }, { simulate: false })
        // Best-ranked quote whose target the contract owner has allowlisted.
        for (const q of ranked) {
          if (!q.transaction) continue
          if (!(await isAllowed(q.transaction.to))) {
            status.lastError = `${q.provider} target ${q.transaction.to} is not allowlisted on the orders contract.`
            continue
          }
          const feeUsdc6 = expectedFeeUsdc6({ outputIsQuoteToken: c.buyToken.toLowerCase() === quoteToken.toLowerCase(), buyAmount: q.buyAmount, sellAmount: c.sellAmount, feeBps: ctx.feeBps })
          return { fn: c.fn, args: [c.id, q.transaction.to as Address, q.transaction.data as Hex], key, maintenance: false, feeUsdc6 }
        }
      } catch {
        // fall through to backoff
      }
      ctx.backoff.fail(key)
      return null
    })
    for (const j of built) if (j) jobs.push(j)
  }
  if (jobs.length === 0) return

  // Estimate gas (this also simulates: a revert means "not executable right now", which is normal),
  // then drop executions whose fee would not cover gas.
  const gasPrice = (await publicClient.getGasPrice().catch(() => ctx.gasFloorWei)) || ctx.gasFloorWei
  const effectiveGasPrice = gasPrice > ctx.gasFloorWei ? gasPrice : ctx.gasFloorWei
  const prepared = (
    await mapLimit(jobs, 8, async (job): Promise<Prepared | null> => {
      let gas: bigint
      try {
        gas = await publicClient.estimateContractGas({ address, abi: ordersAbi, functionName: job.fn, args: job.args as never, account: ctx.wallet.account } as never)
      } catch {
        if (!job.maintenance) {
          metrics.keeper.failedExecutions += 1
          ctx.backoff.fail(job.key)
        }
        return null
      }
      if (!job.maintenance && !isProfitable(ctx.profit, job.feeUsdc6 ?? 0n, gas, effectiveGasPrice)) {
        metrics.keeper.skippedUnprofitable += 1
        ctx.backoff.fail(job.key)
        return null
      }
      return { job, gas }
    })
  ).filter((p): p is Prepared => p !== null)
  if (prepared.length === 0) return

  // Several ready executions go in one executeMany transaction (v2 contracts), which saves the
  // per-transaction overhead and one nonce each. Items were already simulated individually above.
  if (ctx.batch === undefined) {
    ctx.batch = await publicClient.readContract({ address, abi: ordersAbi, functionName: 'minOrderQuote' }).then(() => true).catch(() => false)
    status.notes.push(ctx.batch ? 'Contract supports executeMany: ready executions are batched.' : 'Contract has no executeMany (v1): executions are sent one by one.')
  }
  const singles = prepared.filter((p) => p.job.fn === 'execute')
  if (ctx.batch && singles.length >= 2) {
    const rest = prepared.filter((p) => p.job.fn !== 'execute')
    const groups: Prepared[][] = []
    for (let i = 0; i < singles.length; i += ctx.batchMax) groups.push(singles.slice(i, i + ctx.batchMax))
    prepared.length = 0
    prepared.push(...rest)
    for (const group of groups) {
      if (group.length < 2) {
        prepared.push(...group)
        continue
      }
      const args = [group.map((g) => g.job.args[0] as bigint), group.map((g) => g.job.args[1] as Address), group.map((g) => g.job.args[2] as Hex)] as const
      try {
        const gas = await publicClient.estimateContractGas({ address, abi: ordersAbi, functionName: 'executeMany', args: args as never, account: ctx.wallet.account } as never)
        metrics.keeper.batches += 1
        prepared.push({ job: { fn: 'executeMany', args, key: `batch:${group.map((g) => g.job.key).join(',')}`, maintenance: false, members: group.map((g) => g.job) }, gas })
      } catch {
        prepared.push(...group) // fall back to individual sends
      }
    }
  }

  // Broadcast back to back with explicit nonces (no waiting between sends), then confirm in parallel.
  const fees = applyGasFloor(await publicClient.estimateFeesPerGas().catch(() => undefined), ctx.gasFloorWei)
  const nonce = new NonceTracker(await publicClient.getTransactionCount({ address: ctx.wallet.account!.address, blockTag: 'pending' }))
  const sent: { p: Prepared; hash: Hex }[] = []
  for (const p of prepared) {
    try {
      const hash = await ctx.wallet.writeContract({
        address,
        abi: ordersAbi,
        functionName: p.job.fn,
        args: p.job.args,
        account: ctx.wallet.account,
        chain: ctx.wallet.chain,
        nonce: nonce.next(),
        gas: (p.gas * 12n) / 10n,
        ...fees,
      } as never)
      metrics.keeper.txSent += 1
      sent.push({ p, hash })
    } catch {
      // A failed send can leave a nonce gap. Stop here; the next tick re-reads the pending count.
      metrics.keeper.txFailed += 1
      break
    }
  }
  await Promise.all(
    sent.map(async ({ p, hash }) => {
      let ok = false
      try {
        ok = (await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })).status === 'success'
      } catch {
        ok = false
      }
      const { job } = p
      if (job.members) {
        // executeMany skips items that cannot execute: count what actually ran from the receipt events.
        let done = new Set<string>()
        if (ok) {
          const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null)
          if (receipt) {
            const events = parseEventLogs({ abi: ordersAbi, logs: receipt.logs, eventName: 'OrderExecuted' })
            done = new Set(events.map((e) => `o${e.args.id}`))
          }
        }
        for (const m of job.members) {
          if (done.has(m.key)) {
            status.executed += 1
            metrics.keeper.executed += 1
            ctx.backoff.clear(m.key)
          } else {
            metrics.keeper.failedExecutions += 1
            ctx.backoff.fail(m.key)
          }
        }
        if (!ok) metrics.keeper.txFailed += 1
        return
      }
      if (job.maintenance) {
        metrics.keeper.maintenanceCalls += 1
        if (!ok) metrics.keeper.txFailed += 1
        else if (job.fn === 'expireOrder') ctx.openOrders.delete(job.args[0] as bigint)
        return
      }
      if (ok) {
        status.executed += 1
        metrics.keeper.executed += 1
        ctx.backoff.clear(job.key)
      } else {
        metrics.keeper.failedExecutions += 1
        metrics.keeper.txFailed += 1
        ctx.backoff.fail(job.key)
      }
    }),
  )
}

type JobFn = 'execute' | 'executeMany' | 'executeDca' | 'expireOrder' | 'activateStop' | 'pokeTrailing'

interface Job {
  fn: JobFn
  args: readonly unknown[]
  key: string
  maintenance: boolean
  /** Expected keeper fee in 6-decimal USDC units (executions only). */
  feeUsdc6?: bigint
  /** For executeMany: the individual executions it carries. */
  members?: Job[]
}

interface Prepared {
  job: Job
  gas: bigint
}

/**
 * Subscribes to order and DCA lifecycle events over WebSocket and calls `onEvent` for each batch.
 * viem reconnects the socket by itself; errors are logged and never stop the polling loop.
 */
function startEventWake(ctx: Ctx, chain: typeof arc | typeof arcTestnet, wsUrl: string, onEvent: () => void): void {
  try {
    const client = createPublicClient({ chain, transport: webSocket(wsUrl, { reconnect: true, retryCount: 5 }) })
    const events = ordersAbi.filter((x) => x.type === 'event' && ['OrderCreated', 'DcaCreated', 'DcaResumed'].includes(x.name))
    client.watchEvent({
      address: ctx.address,
      events: events as never,
      onLogs: () => onEvent(),
      onError: (e) => {
        status.notes = status.notes.filter((n) => !n.startsWith('Event wake error'))
        status.notes.push(`Event wake error (polling continues): ${redactSecrets(e.message).slice(0, 120)}`)
      },
    })
  } catch (e) {
    status.notes.push(`Event wake could not start (polling continues): ${e instanceof Error ? redactSecrets(e.message).slice(0, 120) : 'unknown error'}`)
  }
}
