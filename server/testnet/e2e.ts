/**
 * Live end-to-end test on Arc Testnet. Drives real transactions through the deployed order contract,
 * the test feeds and the test router, and expects a keeper (bun run server with KEEPER_ENABLED=true)
 * to submit the executions. Run after the config timelock has passed:
 *
 *   bun run server/testnet/apply-config.ts
 *   KEEPER_ENABLED=true KEEPER_INTERVAL_MS=3000 KEEPER_PRIVATE_KEY=$TESTNET_DEPLOYER_PRIVATE_KEY bun run server
 *   bun run server/testnet/e2e.ts
 *
 * Uses a throwaway trader wallet funded from the deployer. Amounts are tiny because the test router
 * pays sells out of its own USDC balance.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits, type Abi, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '../../src/onchain-facts'
import { ordersAbi } from '../../src/trading/ordersAbi'
import harness from '../../src/trading/testnet-harness.json'

const deployerKey = process.env.TESTNET_DEPLOYER_PRIVATE_KEY as Hex | undefined
if (!deployerKey) throw new Error('TESTNET_DEPLOYER_PRIVATE_KEY is not set in .env')
const rpc = getChain(arcTestnet.id)?.rpcUrls[0]
const usdcFact = getUsdc(arcTestnet.id)
if (!rpc || !usdcFact) throw new Error('Arc Testnet facts missing')
const USDC = usdcFact.address as Address
const ORDERS = harness.orders as Address
const ROUTER = harness.router as Address

const pub = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
const deployer = privateKeyToAccount(deployerKey)
const trader = privateKeyToAccount(generatePrivateKey())
const deployerWallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: http(rpc) })
const traderWallet = createWalletClient({ account: trader, chain: arcTestnet, transport: http(rpc) })

const feedAbi = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
  { type: 'function', name: 'setPrice', stateMutability: 'nonpayable', inputs: [{ name: 'price', type: 'int256' }], outputs: [] },
] as const
const faucetAbi = [{ type: 'function', name: 'faucet', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const
const routerAbi = [
  { type: 'function', name: 'swapExactIn', stateMutability: 'nonpayable', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const

const Side = { BUY: 0, SELL: 1 }
const Type = { LIMIT: 0, STOP_LOSS: 1, TAKE_PROFIT: 2, STOP_LIMIT: 3, TRAILING_STOP: 4, OCO: 5 }
const Status = { OPEN: 0, EXECUTED: 1, CANCELLED: 2, EXPIRED: 3 }

const results: { name: string; ok: boolean; detail: string }[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(wallet: typeof deployerWallet, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never)
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted`)
  return hash
}

const bal = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
const price18 = async (base: Address) => (await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'currentPrice', args: [base] }))[0]
const feedUsd = async (feed: Address) => (await pub.readContract({ address: feed, abi: feedAbi, functionName: 'latestRoundData' }))[1]
const bps = (v: bigint, b: number) => (v * BigInt(10_000 + b)) / 10_000n

async function setFeedPct(feed: Address, pct: number, from?: bigint) {
  const cur = from ?? (await feedUsd(feed))
  const next = (cur * BigInt(Math.round((100 + pct) * 100))) / 10_000n
  await send(deployerWallet, feed, feedAbi as unknown as Abi, 'setPrice', [next])
  return next
}

async function getOrder(id: bigint) {
  return pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'getOrder', args: [id] })
}

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 150_000): Promise<T> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v !== null) return v
    await sleep(3_000)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function createOrder(p: { base: Address; side: number; type: number; amountIn: bigint; trigger?: bigint; limit?: bigint; trailBps?: number; slippage?: number; expirySec?: number }) {
  const expiry = Math.floor(Date.now() / 1000) + (p.expirySec ?? 3600)
  await send(traderWallet, ORDERS, ordersAbi as unknown as Abi, 'createOrder', [
    { base: p.base, side: p.side, orderType: p.type, amountIn: p.amountIn, triggerPrice: p.trigger ?? 0n, limitPrice: p.limit ?? 0n, trailBps: p.trailBps ?? 0, maxSlippageBps: p.slippage ?? 300, expiry },
  ])
  const id = (await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'nextOrderId' })) - 1n
  return id
}

async function scenario(name: string, fn: () => Promise<string>) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`PASS ${name} (${Math.round((Date.now() - started) / 1000)}s): ${detail}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
    results.push({ name, ok: false, detail: msg })
    console.log(`FAIL ${name}: ${msg}`)
  }
}

async function main() {
  const tokens = Object.fromEntries(harness.assets.map((a) => [a.symbol, a])) as Record<string, (typeof harness.assets)[number]>
  const t = (s: string) => tokens[s].address as Address
  const f = (s: string) => tokens[s].feed as Address

  console.log(`trader ${trader.address}`)
  // Gas for the trader (USDC is the native gas token on Arc).
  const gasHash = await deployerWallet.sendTransaction({ to: trader.address, value: parseUnits('1.1', 18) })
  await pub.waitForTransactionReceipt({ hash: gasHash })
  for (const s of ['tBTC', 'tETH', 'tSOL']) await send(traderWallet, t(s), faucetAbi as unknown as Abi, 'faucet', [])
  for (const s of ['tBTC', 'tETH', 'tSOL']) await send(traderWallet, t(s), erc20Abi as unknown as Abi, 'approve', [ORDERS, 2n ** 255n])
  await send(traderWallet, USDC, erc20Abi as unknown as Abi, 'approve', [ORDERS, 2n ** 255n])

  // Sanity: the contract sees the test feeds.
  await scenario('oracle reads test feeds through the order contract', async () => {
    const out: string[] = []
    for (const s of ['tBTC', 'tETH', 'tSOL']) {
      const p = await price18(t(s))
      const usd = Number(await feedUsd(f(s))) / 1e8
      const read = Number(p) / 1e18
      if (Math.abs(read - usd) / usd > 0.001) throw new Error(`${s}: contract ${read} vs feed ${usd}`)
      out.push(`${s} $${read.toFixed(2)}`)
    }
    return out.join(', ')
  })

  const amtBtc = parseUnits('0.00002', 8)
  const amtEth = parseUnits('0.0007', 18)
  const amtSol = parseUnits('0.015', 9)

  await scenario('limit sell fills through keeper after price rises', async () => {
    const p0 = await price18(t('tBTC'))
    const before = await bal(USDC, trader.address)
    const id = await createOrder({ base: t('tBTC'), side: Side.SELL, type: Type.LIMIT, amountIn: amtBtc, trigger: bps(p0, 300) })
    const chk = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'checkOrder', args: [id] })
    if (chk[0]) throw new Error('order was executable before the trigger')
    const feedStart = await feedUsd(f('tBTC'))
    await setFeedPct(f('tBTC'), 4, feedStart)
    const o = await waitFor('limit fill', async () => {
      const x = await getOrder(id)
      return x.status === Status.EXECUTED ? x : null
    })
    const gained = (await bal(USDC, trader.address)) - before
    const gross = (amtBtc * bps(p0, 400)) / 10n ** 8n / 10n ** 12n
    if (gained <= 0n || gained < (gross * 95n) / 100n) throw new Error(`gained ${gained}, expected near ${gross}`)
    await send(deployerWallet, f('tBTC'), feedAbi as unknown as Abi, 'setPrice', [feedStart])
    return `received ${Number(gained) / 1e6} USDC at execution price ${Number(o.executionPrice) / 1e18}`
  })

  await scenario('stop-loss sells on a drop', async () => {
    const p0 = await price18(t('tETH'))
    const feedStart = await feedUsd(f('tETH'))
    const id = await createOrder({ base: t('tETH'), side: Side.SELL, type: Type.STOP_LOSS, amountIn: amtEth, trigger: bps(p0, -500) })
    await setFeedPct(f('tETH'), -8, feedStart)
    const o = await waitFor('stop fill', async () => ((await getOrder(id)).status === Status.EXECUTED ? getOrder(id) : null))
    await send(deployerWallet, f('tETH'), feedAbi as unknown as Abi, 'setPrice', [feedStart])
    return `filled at ${Number(o.executionPrice) / 1e18}`
  })

  await scenario('take-profit sells on a rise', async () => {
    const p0 = await price18(t('tSOL'))
    const feedStart = await feedUsd(f('tSOL'))
    const id = await createOrder({ base: t('tSOL'), side: Side.SELL, type: Type.TAKE_PROFIT, amountIn: amtSol, trigger: bps(p0, 500) })
    await setFeedPct(f('tSOL'), 7, feedStart)
    const o = await waitFor('tp fill', async () => ((await getOrder(id)).status === Status.EXECUTED ? getOrder(id) : null))
    await send(deployerWallet, f('tSOL'), feedAbi as unknown as Abi, 'setPrice', [feedStart])
    return `filled at ${Number(o.executionPrice) / 1e18}`
  })

  await scenario('trailing stop records the peak then sells on reversal', async () => {
    const feedStart = await feedUsd(f('tBTC'))
    const id = await createOrder({ base: t('tBTC'), side: Side.SELL, type: Type.TRAILING_STOP, amountIn: amtBtc, trailBps: 500 })
    const high = await setFeedPct(f('tBTC'), 12, feedStart)
    const peaked = await waitFor('peak poke', async () => {
      const x = await getOrder(id)
      return x.peakPrice > bps(await price18(t('tBTC')), -200) ? x : null
    })
    if (peaked.status !== Status.OPEN) throw new Error('order closed before the reversal')
    await send(deployerWallet, f('tBTC'), feedAbi as unknown as Abi, 'setPrice', [(high * 9_000n) / 10_000n])
    const o = await waitFor('trailing fill', async () => ((await getOrder(id)).status === Status.EXECUTED ? getOrder(id) : null))
    await send(deployerWallet, f('tBTC'), feedAbi as unknown as Abi, 'setPrice', [feedStart])
    return `peak ${Number(peaked.peakPrice) / 1e18}, filled at ${Number(o.executionPrice) / 1e18}`
  })

  await scenario('OCO: take-profit leg fires once and the order cannot run again', async () => {
    const p0 = await price18(t('tETH'))
    const feedStart = await feedUsd(f('tETH'))
    const id = await createOrder({ base: t('tETH'), side: Side.SELL, type: Type.OCO, amountIn: amtEth, trigger: bps(p0, -500), limit: bps(p0, 500) })
    await setFeedPct(f('tETH'), 7, feedStart)
    await waitFor('oco fill', async () => ((await getOrder(id)).status === Status.EXECUTED ? true : null))
    await send(deployerWallet, f('tETH'), feedAbi as unknown as Abi, 'setPrice', [feedStart])
    const again = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'checkOrder', args: [id] })
    if (again[0] || again[1] !== 1) throw new Error('executed OCO still reports as executable')
    return 'executed once; further execution reports "not open"'
  })

  await scenario('stop-limit: activation persists, no fill below the limit, fills after a rebound', async () => {
    const p0 = await price18(t('tSOL'))
    const feedStart = await feedUsd(f('tSOL'))
    const id = await createOrder({ base: t('tSOL'), side: Side.SELL, type: Type.STOP_LIMIT, amountIn: amtSol, trigger: bps(p0, -500), limit: bps(p0, -600) })
    await setFeedPct(f('tSOL'), -9, feedStart)
    await waitFor('stop activation', async () => ((await getOrder(id)).stopActivated ? true : null))
    await sleep(8_000)
    if ((await getOrder(id)).status !== Status.OPEN) throw new Error('filled below the limit price')
    await setFeedPct(f('tSOL'), -5.5, feedStart)
    const o = await waitFor('stop-limit fill', async () => ((await getOrder(id)).status === Status.EXECUTED ? getOrder(id) : null))
    await send(deployerWallet, f('tSOL'), feedAbi as unknown as Abi, 'setPrice', [feedStart])
    return `activated, held unfilled below limit, filled at ${Number(o.executionPrice) / 1e18} after rebound`
  })

  await scenario('cancel refunds the escrow', async () => {
    const p0 = await price18(t('tBTC'))
    const before = await bal(t('tBTC'), trader.address)
    const id = await createOrder({ base: t('tBTC'), side: Side.SELL, type: Type.LIMIT, amountIn: amtBtc, trigger: bps(p0, 2000) })
    if ((await bal(t('tBTC'), trader.address)) !== before - amtBtc) throw new Error('escrow not taken')
    await send(traderWallet, ORDERS, ordersAbi as unknown as Abi, 'cancelOrder', [id])
    if ((await bal(t('tBTC'), trader.address)) !== before) throw new Error('refund missing')
    if ((await getOrder(id)).status !== Status.CANCELLED) throw new Error('status not cancelled')
    return 'escrow taken then fully refunded'
  })

  await scenario('expired order is refunded by a keeper', async () => {
    const p0 = await price18(t('tBTC'))
    const before = await bal(t('tBTC'), trader.address)
    const id = await createOrder({ base: t('tBTC'), side: Side.SELL, type: Type.LIMIT, amountIn: amtBtc, trigger: bps(p0, 2000), expirySec: 45 })
    await waitFor('expiry refund', async () => ((await getOrder(id)).status === Status.EXPIRED ? true : null), 120_000)
    if ((await bal(t('tBTC'), trader.address)) !== before) throw new Error('refund missing after expiry')
    return 'expired and refunded'
  })

  await scenario('DCA buys on schedule, then pause, resume and cancel refund the rest', async () => {
    const per = parseUnits('0.4', 6)
    const before = await bal(USDC, trader.address)
    await send(traderWallet, ORDERS, ordersAbi as unknown as Abi, 'createDca', [t('tBTC'), per, 2, 3600, 0, 300, 0n])
    const id = (await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'nextDcaId' })) - 1n
    const d = await waitFor('first dca buy', async () => {
      const x = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'getDca', args: [id] })
      return x.executions >= 1 ? x : null
    })
    await send(traderWallet, ORDERS, ordersAbi as unknown as Abi, 'pauseDca', [id])
    await send(traderWallet, ORDERS, ordersAbi as unknown as Abi, 'resumeDca', [id])
    await send(traderWallet, ORDERS, ordersAbi as unknown as Abi, 'cancelDca', [id])
    const after = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'getDca', args: [id] })
    // USDC is also the gas token on Arc, so the wallet balance moves by gas as well as by the plan.
    const spent = before - (await bal(USDC, trader.address))
    if (after.status !== 2) throw new Error('plan not cancelled')
    if (d.totalSpent !== per) throw new Error(`recorded spend ${d.totalSpent}, expected one buy of ${per}`)
    if (spent < per || spent > per + parseUnits('0.1', 6)) throw new Error(`wallet moved ${spent}, expected about ${per} plus gas (the remaining budget should be refunded)`)
    return `1 buy executed (${Number(d.totalSpent) / 1e6} USDC), the remaining budget was refunded`
  })

  await scenario('market swap through the test router (what the UI sends)', async () => {
    const before = await bal(t('tETH'), trader.address)
    const amount = parseUnits('0.3', 6)
    await send(traderWallet, USDC, erc20Abi as unknown as Abi, 'approve', [ROUTER, amount])
    await send(traderWallet, ROUTER, routerAbi as unknown as Abi, 'swapExactIn', [USDC, t('tETH'), amount])
    const got = (await bal(t('tETH'), trader.address)) - before
    if (got <= 0n) throw new Error('no tETH received')
    return `0.3 USDC bought ${Number(got) / 1e18} tETH`
  })

  // ---- v2 contract features -------------------------------------------------------------------------

  await scenario('v2: an order below the minimum size is rejected', async () => {
    const min = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'minOrderQuote' })
    if (min === 0n) return 'skipped: this deployment has no minimum order size set'
    const tiny = min / 2n
    try {
      await createOrder({ base: t('tETH'), side: Side.BUY, type: Type.LIMIT, amountIn: tiny, trigger: (await price18(t('tETH'))) * 2n })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/OrderTooSmall|too small/i.test(msg)) throw new Error(`rejected, but not as OrderTooSmall: ${msg.split('\n')[0]}`)
      return `${Number(tiny) / 1e6} USDC rejected (minimum ${Number(min) / 1e6})`
    }
    throw new Error('a dust order was accepted')
  })

  await scenario('v2: paged views agree with the full id list', async () => {
    const all = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'getOrderIds', args: [trader.address] })
    const count = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'orderCount', args: [trader.address] })
    const page = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'getOrderIdsPage', args: [trader.address, 1n, 3n] })
    if (BigInt(all.length) !== count) throw new Error(`count ${count} vs ${all.length} ids`)
    if (page.length !== Math.min(3, all.length - 1) || page.some((id, i) => id !== all[i + 1])) throw new Error('page does not match the id list')
    const orders = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'getOrders', args: [[...page]] })
    if (orders.length !== page.length || orders.some((o) => o.owner.toLowerCase() !== trader.address.toLowerCase())) throw new Error('getOrders mismatch')
    return `${all.length} orders, page of ${page.length} matches`
  })

  await scenario('v2: a keeper batches several ready orders into one executeMany transaction', async () => {
    const now = await price18(t('tETH'))
    const trigger = (now * 103n) / 100n
    const ids: bigint[] = []
    for (let i = 0; i < 3; i++) ids.push(await createOrder({ base: t('tETH'), side: Side.SELL, type: Type.LIMIT, amountIn: amtEth, trigger }))
    await setFeedPct(f('tETH'), 6)
    await waitFor('all three batch orders executed', async () => {
      const orders = await Promise.all(ids.map((id) => getOrder(id)))
      return orders.every((o) => o.status === Status.EXECUTED) ? true : null
    })
    const logs = await pub.getContractEvents({ address: ORDERS, abi: ordersAbi, eventName: 'OrderExecuted', args: { owner: trader.address }, fromBlock: (await pub.getBlockNumber()) - 3_000n })
    const byTx = new Map<string, number>()
    for (const l of logs) if (ids.includes(l.args.id as bigint)) byTx.set(l.transactionHash, (byTx.get(l.transactionHash) ?? 0) + 1)
    const largest = Math.max(...byTx.values())
    if (largest < 2) throw new Error(`executed in ${byTx.size} separate transactions; no batch was used (is the keeper on a v2 contract with batching on?)`)
    return `${ids.length} orders executed in ${byTx.size} transaction(s), ${largest} in a single executeMany`
  })

  // Return what is left to the deployer so repeated runs only cost gas (testnet USDC is scarce).
  try {
    const left = await pub.getBalance({ address: trader.address })
    const reserve = parseUnits('0.02', 18)
    if (left > reserve) {
      const hash = await traderWallet.sendTransaction({ to: deployer.address, value: left - reserve })
      await pub.waitForTransactionReceipt({ hash })
      console.log(`swept ${Number(left - reserve) / 1e18} USDC back to the deployer`)
    }
  } catch (e) {
    console.log(`sweep skipped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`)
  await Bun.write(`${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/e2e-results.json`, JSON.stringify({ trader: trader.address, results }, null, 2))
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
