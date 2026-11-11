/**
 * Mainnet-fork test of the order contract against the REAL KyberSwap router and real Arc pools.
 * It answers the question unit tests cannot: does keeper-supplied aggregator calldata survive the
 * contract's exact-spend and net-output checks on a live route, and are hostile variants rejected?
 *
 *   anvil --fork-url https://rpc.mainnet.arc.io --port 8546 --chain-id 5042 --silent &
 *   bun run scripts/fork-mainnet-test.ts            # default RPC http://127.0.0.1:8546
 *
 * REQUIREMENT: the fork client must support Arc's native-USDC precompile. Stock Foundry (anvil) can read
 * USDC balances and set allowances on a fork but every USDC transfer reverts with empty data, so this script
 * stops early with exit code 2 and says so. Use Arc's Foundry fork (see docs/deployment.md) to run it fully.
 *
 * Everything happens on a local fork with throwaway accounts that exist only in this process. Nothing is sent to mainnet,
 * and the script refuses to run against a non-local RPC. Needs contracts/out (run `forge build`).
 * The price feeds are test feeds set from the live KyberSwap price, because this is about swap calldata,
 * not about Chainlink.
 */
import { readFile } from 'node:fs/promises'
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, type Abi, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arc } from 'viem/chains'
import { ordersAbi } from '../src/trading/ordersAbi'

const RPC = process.argv[2] ?? 'http://127.0.0.1:8546'
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC)) throw new Error('Refusing to run: RPC must be a local anvil fork.')

const USDC: Address = '0x3600000000000000000000000000000000000000'
const EURC: Address = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
const KYBER_ROUTER: Address = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
const KYBER = 'https://aggregator-api.kyberswap.com/arc/api/v1'

// Fresh random accounts: KyberSwap's build API rejects well-known burner addresses (anvil's defaults) as wallets.
const fresh = () => privateKeyToAccount(generatePrivateKey())
const owner = fresh()
const user = fresh()
const keeper = fresh()
const attacker = fresh()

const transport = http(RPC)
const pub = createPublicClient({ chain: arc, transport })
const test = createTestClient({ chain: arc, mode: 'anvil', transport })
const wallet = (account: typeof owner) => createWalletClient({ account, chain: arc, transport })

async function artifact(file: string, name: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const j = JSON.parse(await readFile(`contracts/out/${file}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: j.abi, bytecode: j.bytecode.object }
}

async function deploy(account: typeof owner, file: string, name: string, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = await artifact(file, name)
  const hash = await wallet(account).deployContract({ abi, bytecode, args })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (!r.contractAddress) throw new Error(`${name} deploy failed`)
  return r.contractAddress
}

async function send(account: typeof owner, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  let hash: Hex
  try {
    hash = await wallet(account).writeContract({ address, abi, functionName, args })
  } catch (e) {
    // Surface the decoded custom error (viem puts it on the cause chain).
    const err = e as { cause?: { data?: { errorName?: string; args?: unknown[] }; reason?: string; signature?: string }; shortMessage?: string }
    const name = err.cause?.data?.errorName ?? err.cause?.reason ?? err.cause?.signature
    throw new Error(`${functionName} reverted${name ? ` with ${name}` : ''}${err.cause?.data?.args ? ` ${JSON.stringify(err.cause.data.args, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}` : ''}`)
  }
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted`)
  return r
}

async function expectRevert(label: string, run: () => Promise<unknown>, mustContain?: string): Promise<string> {
  try {
    await run()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (mustContain && !msg.includes(mustContain)) throw new Error(`${label}: reverted, but not with ${mustContain}: ${msg.slice(0, 200)}`)
    return `${label}: rejected`
  }
  throw new Error(`${label}: expected a revert but the call succeeded`)
}

const results: { name: string; ok: boolean; detail: string }[] = []
async function scenario(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`PASS ${name}: ${detail}`)
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 300) : String(e)
    results.push({ name, ok: false, detail })
    console.log(`FAIL ${name}: ${detail}`)
  }
}

async function kyberCalldata(sellAmount: bigint, taker: Address, chainNow: bigint): Promise<{ data: Hex; router: Address; amountOut: bigint }> {
  const qs = new URLSearchParams({ tokenIn: USDC, tokenOut: EURC, amountIn: sellAmount.toString(), gasInclude: 'true' })
  const route = (await (await fetch(`${KYBER}/routes?${qs}`, { headers: { 'x-client-id': 'arc-terminal-fork-test' } })).json()) as { code: number; data?: { routeSummary: Record<string, unknown>; routerAddress: Address }; message?: string }
  if (route.code !== 0 || !route.data) throw new Error(`Kyber route failed: ${route.message}`)
  const build = (await (
    await fetch(`${KYBER}/route/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'arc-terminal-fork-test' },
      // The fork's clock is ahead of real time after the timelock jump, so the deadline follows the chain clock.
      body: JSON.stringify({ routeSummary: route.data.routeSummary, sender: taker, recipient: taker, slippageTolerance: 100, deadline: Number(chainNow) + 1800 }),
    })
  ).json()) as { code: number; data?: { data: Hex; routerAddress: Address; amountOut: string }; message?: string }
  if (build.code !== 0 || !build.data) throw new Error(`Kyber build failed: ${JSON.stringify(build).slice(0, 300)}`)
  return { data: build.data.data, router: build.data.routerAddress, amountOut: BigInt(build.data.amountOut) }
}

async function main() {
  const chainId = await pub.getChainId()
  if (chainId !== 5042) throw new Error(`Fork reports chain ${chainId}, expected 5042`)
  console.log(`fork block ${await pub.getBlockNumber()}`)
  await test.setBalance({ address: owner.address, value: 10n * 10n ** 18n })

  // Precheck: can this fork client move USDC at all?
  const probeFrom = fresh()
  await test.setBalance({ address: probeFrom.address, value: 2n * 10n ** 18n })
  try {
    await send(probeFrom, USDC, erc20Abi, 'transfer', [owner.address, 1_000_000n])
  } catch {
    console.log('SKIP: this fork client cannot execute USDC transfers (Arc native-USDC precompile is not emulated).')
    console.log("Run it with Arc's Foundry fork instead of stock anvil. The script is otherwise ready.")
    process.exit(2)
  }

  // Price EURC from the live route so the oracle-based minimum output is realistic.
  const probe = await kyberCalldata(1_000_000n, owner.address, BigInt(Math.floor(Date.now() / 1000)))
  const eurcUsd = 1_000_000 / Number(probe.amountOut) // USD per EURC (1 USDC buys amountOut/1e6 EURC)
  console.log(`live EURC price ~ ${eurcUsd.toFixed(4)} USD`)

  const orders = await deploy(owner, 'ArcTradeOrders', 'ArcTradeOrders', [owner.address, USDC, 3600])
  const usdcFeed = await deploy(owner, 'TestPriceFeed', 'TestPriceFeed', ['USDC / USD', 100_000_000n])
  const eurcFeed = await deploy(owner, 'TestPriceFeed', 'TestPriceFeed', ['EURC / USD', BigInt(Math.round(eurcUsd * 1e8))])

  const queued: Hex[] = []
  for (const [fn, args] of [
    ['queueTokenConfig', [USDC, usdcFeed, 172_800]],
    ['queueTokenConfig', [EURC, eurcFeed, 172_800]],
    ['queueSwapTarget', [KYBER_ROUTER, true]],
  ] as const) {
    const r = await send(owner, orders, ordersAbi, fn, [...args])
    const ev = r.logs.find((l) => l.address.toLowerCase() === orders.toLowerCase())!
    queued.push(ev.topics[1] as Hex)
  }
  // The timelock is real: jump the fork's clock past it, then apply.
  await test.increaseTime({ seconds: 3601 })
  await test.mine({ blocks: 1 })
  // Re-stamp the feeds so they are fresh relative to the jumped clock.
  for (const feed of [usdcFeed, eurcFeed]) {
    const price = feed === usdcFeed ? 100_000_000n : BigInt(Math.round(eurcUsd * 1e8))
    await send(owner, feed, [{ type: 'function', name: 'setPrice', stateMutability: 'nonpayable', inputs: [{ name: 'price', type: 'int256' }], outputs: [] }] as Abi, 'setPrice', [price])
  }
  for (const id of queued) await send(owner, orders, ordersAbi, 'applyConfig', [id])

  const nowChain = (await pub.getBlock()).timestamp
  const [price18] = (await pub.readContract({ address: orders, abi: ordersAbi, functionName: 'currentPrice', args: [EURC] }))
  console.log(`orders ${orders}, oracle EURC price ${Number(price18) / 1e18}`)

  await test.setBalance({ address: user.address, value: 100n * 10n ** 18n })
  await test.setBalance({ address: keeper.address, value: 10n * 10n ** 18n })
  await test.setBalance({ address: attacker.address, value: 10n * 10n ** 18n })
  const usdcBal = (a: Address) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
  const eurcBal = (a: Address) => pub.readContract({ address: EURC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })

  const AMOUNT = 5_000_000n
  const createBuy = async () => {
    await send(user, USDC, erc20Abi, 'approve', [orders, AMOUNT])
    const params = {
      base: EURC,
      side: 0,
      orderType: 0,
      amountIn: AMOUNT,
      triggerPrice: (price18 * 105n) / 100n, // buy limit above market, so it is triggered now
      limitPrice: 0n,
      trailBps: 0,
      maxSlippageBps: 500,
      expiry: Number(nowChain) + 86_400,
    }
    await send(user, orders, ordersAbi, 'createOrder', [params])
    return (await pub.readContract({ address: orders, abi: ordersAbi, functionName: 'nextOrderId' })) - 1n
  }

  await scenario('real KyberSwap calldata fills a keeper-executed buy order', async () => {
    const id = await createBuy()
    const q = await kyberCalldata(AMOUNT, orders, nowChain)
    const userBefore = await eurcBal(user.address)
    const keeperBefore = await eurcBal(keeper.address)
    await send(keeper, orders, ordersAbi, 'execute', [id, q.router, q.data])
    const got = (await eurcBal(user.address)) - userBefore
    const fee = (await eurcBal(keeper.address)) - keeperBefore
    const left = await usdcBal(orders)
    const allowance = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [orders, KYBER_ROUTER] })
    if (got <= 0n) throw new Error('user received no EURC')
    if (allowance !== 0n) throw new Error(`standing allowance ${allowance} left on the router`)
    if (left !== 0n) throw new Error(`orders contract still holds ${left} USDC after the fill`)
    const o = (await pub.readContract({ address: orders, abi: ordersAbi, functionName: 'getOrder', args: [id] })) as { status: number }
    if (o.status !== 1) throw new Error(`order status ${o.status}, expected EXECUTED`)
    return `5 USDC -> ${Number(got) / 1e6} EURC to the user, keeper fee ${Number(fee) / 1e6} EURC, no leftover escrow or allowance`
  })

  await scenario('calldata that sends the output to the keeper is rejected', async () => {
    const id = await createBuy()
    const q = await kyberCalldata(AMOUNT, keeper.address, nowChain) // recipient = keeper, not the contract
    return expectRevert('hostile recipient', () => send(keeper, orders, ordersAbi, 'execute', [id, q.router, q.data]))
  })

  await scenario('a non-allowlisted target is rejected before any call', async () => {
    const id = await createBuy()
    const q = await kyberCalldata(AMOUNT, orders, nowChain)
    return expectRevert('unlisted target', () => send(keeper, orders, ordersAbi, 'execute', [id, attacker.address, q.data]), 'SwapTargetNotAllowed')
  })

  await scenario('calldata for a smaller amount is rejected (exact-spend rule)', async () => {
    const id = await createBuy()
    const q = await kyberCalldata(AMOUNT / 2n, orders, nowChain)
    return expectRevert('partial spend', () => send(keeper, orders, ordersAbi, 'execute', [id, q.router, q.data]))
  })

  await scenario('the owner can still cancel and recover the escrow of a stuck order', async () => {
    const id = await createBuy()
    const before = await usdcBal(user.address)
    await send(user, orders, ordersAbi, 'cancelOrder', [id])
    const refunded = (await usdcBal(user.address)) - before
    if (refunded < AMOUNT - 1n) throw new Error(`refunded ${refunded}`)
    return `refunded ${Number(refunded) / 1e6} USDC`
  })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} fork scenarios passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
