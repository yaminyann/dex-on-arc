/**
 * Live security and failure-handling tests on Arc Testnet against the v2 order contract:
 * access control, the config timelock, pause semantics, oracle protection (stale, future, mismatched round,
 * non-positive, reverting), router allowlist validation, hostile calldata, instant router disable with keeper
 * failover, and fund recovery.
 *
 *   bun run server/testnet/apply-config.ts        # the oracle fixture config must be applied first
 *   bun run server/testnet/e2e-security.ts
 *
 * Reverts are checked with eth_call simulations (no transaction, so no hash); state changes are real
 * transactions and their hashes are listed per scenario and written to docs/test-reports/e2e-security.json.
 * Run it WITHOUT a keeper running: the direct-execution checks must not race one. The failover scenario starts
 * its own keeper. Needs TESTNET_DEPLOYER_PRIVATE_KEY (the order contract owner) and KEEPER_PRIVATE_KEY.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, keccak256, parseEventLogs, parseUnits, stringToHex, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '../../src/onchain-facts'
import { ordersAbi } from '../../src/trading/ordersAbi'
import harness from '../../src/trading/testnet-harness.json'

const deployerKey = process.env.TESTNET_DEPLOYER_PRIVATE_KEY as Hex | undefined
if (!deployerKey) throw new Error('TESTNET_DEPLOYER_PRIVATE_KEY is not set in .env')
const rpc = process.env.RPC_URL_Arc_Testnet ?? getChain(arcTestnet.id)?.rpcUrls[0]
const USDC = getUsdc(arcTestnet.id)?.address as Address
if (!rpc || !USDC) throw new Error('Arc Testnet facts missing')

type H = typeof harness & { routerB: Address; oracleTest: { token: Address; feed: Address } }
const h = harness as H
if (!h.oracleTest || !h.routerB) throw new Error('Run deploy-router-b.ts and deploy-oracle-test.ts first')
const ORDERS = h.orders as Address
const ROUTER_A = h.router as Address
const ROUTER_B = h.routerB
const TORC = h.oracleTest.token
const ORC_FEED = h.oracleTest.feed
const TETH = h.assets.find((a) => a.symbol === 'tETH')!
const TSOL = h.assets.find((a) => a.symbol === 'tSOL')!

const transport = http(rpc)
const pub = createPublicClient({ chain: arcTestnet, transport })
const deployer = privateKeyToAccount(deployerKey)
// Throwaway keys derived from the deployer key and a seed, so leftover funds are always recoverable.
const SEED = process.env.E2E_SEED ?? String(Date.now())
const trader = privateKeyToAccount(keccak256(stringToHex(`${deployerKey}:sec-trader:${SEED}`)))
const outsider = privateKeyToAccount(keccak256(stringToHex(`${deployerKey}:sec-outsider:${SEED}`)))
const wallet = (a: typeof deployer) => createWalletClient({ account: a, chain: arcTestnet, transport })

const feedAbi = JSON.parse(await readFile('contracts/out/TestControllableFeed.sol/TestControllableFeed.json', 'utf8')).abi as Abi
const routerAbi = JSON.parse(await readFile('contracts/out/TestSwapRouter.sol/TestSwapRouter.json', 'utf8')).abi as Abi
const tokenAbi = JSON.parse(await readFile('contracts/out/TestToken.sol/TestToken.json', 'utf8')).abi as Abi
const priceFeedAbi = [
  { type: 'function', name: 'refresh', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'setPrice', stateMutability: 'nonpayable', inputs: [{ name: 'price', type: 'int256' }], outputs: [] },
] as const

interface TxRef { fn: string; hash: string }
const results: { name: string; ok: boolean; detail: string; seconds: number; txs: TxRef[] }[] = []
const sent: TxRef[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(from: typeof deployer, address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<Hex> {
  const hash = await wallet(from).writeContract({ address, abi, functionName, args } as never)
  sent.push({ fn: functionName, hash })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted onchain`)
  return hash
}

/** The call must revert and the decoded error (or selector) must match. */
async function expectRevert(label: string, from: typeof deployer, address: Address, abi: Abi, functionName: string, args: unknown[], match: RegExp): Promise<string> {
  try {
    await pub.simulateContract({ address, abi, functionName, args, account: from } as never)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!match.test(msg)) throw new Error(`${label}: reverted, but not with ${match}: ${msg.split('\n').slice(0, 4).join(' ')}`)
    return label
  }
  throw new Error(`${label}: expected a revert but the call would succeed`)
}

const o = (from: typeof deployer, fn: string, args: unknown[], match: RegExp, label = fn) => expectRevert(label, from, ORDERS, ordersAbi as unknown as Abi, fn, args, match)

const only = (process.env.E2E_ONLY ?? '').split('|').map((x) => x.trim()).filter(Boolean)

async function scenario(name: string, fn: () => Promise<string>) {
  if (only.length && !only.some((x) => name.includes(x))) {
    console.log(`SKIP ${name}`)
    return
  }
  const started = Date.now()
  sent.length = 0
  let ok = true
  let detail: string
  try {
    detail = await fn()
  } catch (e) {
    ok = false
    detail = e instanceof Error ? e.message.split('\n').slice(0, 3).join(' | ') : String(e)
  }
  const seconds = Math.round((Date.now() - started) / 1000)
  results.push({ name, ok, detail, seconds, txs: [...sent] })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${seconds}s): ${detail}`)
  for (const t of sent) console.log(`    tx ${t.fn} ${t.hash}`)
}

const chainNow = async () => (await pub.getBlock()).timestamp
const setFeed = async (answer: bigint, updatedAt: bigint, round: bigint, answered: bigint) => send(deployer, ORC_FEED, feedAbi, 'set', [answer, updatedAt, round, answered])
const healthy = async () => {
  const now = await chainNow()
  return setFeed(100_00_000_000n, now, 100n + now % 1000n, 100n + now % 1000n)
}
const orderOf = (id: bigint) => pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'getOrder', args: [id] })
const nextId = async () => (await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'nextOrderId' })) - 1n
const bal = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

async function createTorcSell(amount: bigint, trigger = 90n * 10n ** 18n) {
  await send(trader, ORDERS, ordersAbi as unknown as Abi, 'createOrder', [
    { base: TORC, side: 1, orderType: 0, amountIn: amount, triggerPrice: trigger, limitPrice: 0n, trailBps: 0, maxSlippageBps: 300, expiry: Number(await chainNow()) + 3600 },
  ])
  return nextId()
}

const EXPECT = {
  stale: /StalePrice/,
  invalid: /InvalidPrice/,
  notOwner: /OwnableUnauthorizedAccount|0x118cdaa7/,
  paused: /EnforcedPause|0xd93c0665/,
  notAllowed: /SwapTargetNotAllowed/,
}

async function main() {
  console.log(`orders ${ORDERS}\nowner ${deployer.address}\ntrader ${trader.address} (seed ${SEED})\noutsider ${outsider.address}`)
  const owner = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'owner' })
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error('the deployer key is not the owner of this order contract')
  for (const to of [trader.address, outsider.address]) {
    const hash = await wallet(deployer).sendTransaction({ to, value: parseUnits(to === trader.address ? (process.env.E2E_FUND ?? '0.3') : (process.env.E2E_OUTSIDER_FUND ?? '0.05'), 18) })
    await pub.waitForTransactionReceipt({ hash })
  }
  const tokenCfg = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'tokenConfigs', args: [TORC] })
  if (tokenCfg[0] === '0x0000000000000000000000000000000000000000') throw new Error('The oracle fixture config is not applied yet. Run apply-config.ts after its delay.')
  // The USDC test feed must be fresh for the oracle tests (it has a two-day staleness window).
  await send(deployer, h.usdcFeed as Address, priceFeedAbi as unknown as Abi, 'refresh')
  await send(trader, TORC, tokenAbi, 'faucet')
  await send(trader, TORC, erc20Abi as unknown as Abi, 'approve', [ORDERS, 2n ** 255n])

  // ================================================================ access control and timelock
  await scenario('access control: a non-owner cannot call any admin function', async () => {
    const zeroId = ('0x' + '00'.repeat(31) + '01') as Hex
    const checked: string[] = []
    const calls: [string, unknown[]][] = [
      ['queueTokenConfig', [TORC, ORC_FEED, 3600]],
      ['queueSwapTarget', [ROUTER_A, true]],
      ['applyConfig', [zeroId]],
      ['cancelConfig', [zeroId]],
      ['disableToken', [TORC]],
      ['disableSwapTarget', [ROUTER_A]],
      ['setKeeperFeeBps', [5]],
      ['setMinOrderQuote', [1n]],
      ['pause', []],
      ['unpause', []],
      ['transferOwnership', [outsider.address]],
    ]
    for (const [fn, args] of calls) checked.push(await o(outsider, fn, args, EXPECT.notOwner))
    return `${checked.length} admin functions all rejected the outsider: ${checked.join(', ')}`
  })

  await scenario('timelock: a queued change cannot be applied early, is fully visible, and can be cancelled', async () => {
    const hash = await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'queueSwapTarget', [ORC_FEED, true]) // any contract; cancelled below
    const receipt = await pub.getTransactionReceipt({ hash })
    const ev = parseEventLogs({ abi: ordersAbi, logs: receipt.logs, eventName: 'ConfigQueued' })[0]
    const { changeId, eta, subject, isToken, allowed } = ev.args as { changeId: Hex; eta: bigint; subject: Address; isToken: boolean; allowed: boolean }
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber })
    const delay = Number(eta - block.timestamp)
    if (delay !== 3600) throw new Error(`delay ${delay}s, expected 3600`)
    if (subject.toLowerCase() !== ORC_FEED.toLowerCase() || isToken || !allowed) throw new Error('ConfigQueued content does not describe the queued change')
    await o(deployer, 'applyConfig', [changeId], /ConfigNotReady/, 'apply before eta')
    await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'cancelConfig', [changeId])
    await o(deployer, 'applyConfig', [changeId], /ConfigUnknown/, 'apply after cancel')
    if ((await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'pendingConfigEta', args: [changeId] })) !== 0n) throw new Error('entry still pending after cancel')
    return `eta = queue time + ${delay}s; ConfigQueued carries subject/flags; early apply -> ConfigNotReady; cancel clears it; later apply -> ConfigUnknown`
  })

  await scenario('keeper fee can only be lowered; minimum order size is bounded', async () => {
    const out = [
      await o(deployer, 'setKeeperFeeBps', [11], /InvalidParameters/, 'raise fee 10 -> 11'),
      await o(deployer, 'setMinOrderQuote', [10_001n * 1_000_000n], /InvalidParameters/, 'min order 10,001 USDC'),
    ]
    return out.join('; ') + ' rejected'
  })

  await scenario('ownership: renounce is disabled and a pending transfer does not change the owner', async () => {
    await o(deployer, 'renounceOwnership', [], /RenounceDisabled/, 'renounce')
    await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'transferOwnership', [trader.address])
    const stillOwner = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'owner' })
    const pending = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'pendingOwner' })
    if (stillOwner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error('owner changed before acceptance')
    if (pending.toLowerCase() !== trader.address.toLowerCase()) throw new Error('pending owner not recorded')
    await o(outsider, 'acceptOwnership', [], /OwnableUnauthorizedAccount|0x118cdaa7/, 'accept by a non-pending address')
    await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'transferOwnership', ['0x0000000000000000000000000000000000000000'])
    return 'renounce -> RenounceDisabled; transferOwnership only sets pendingOwner; an outsider cannot accept; pending cleared'
  })

  await scenario('pause: blocks new orders and execution but never blocks cancel and refund', async () => {
    await healthy()
    const id = await createTorcSell(120_000n) // 0.0012 tORC = $0.12
    const before = await bal(TORC, trader.address)
    await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'pause')
    try {
      await o(trader, 'createOrder', [{ base: TORC, side: 1, orderType: 0, amountIn: 120_000n, triggerPrice: 90n * 10n ** 18n, limitPrice: 0n, trailBps: 0, maxSlippageBps: 300, expiry: Number(await chainNow()) + 3600 }], EXPECT.paused, 'createOrder while paused')
      await o(deployer, 'execute', [id, ROUTER_A, '0x'], EXPECT.paused, 'execute while paused')
      await send(trader, ORDERS, ordersAbi as unknown as Abi, 'cancelOrder', [id])
    } finally {
      await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'unpause')
    }
    const after = await bal(TORC, trader.address)
    if (after !== before + 120_000n) throw new Error(`refund ${after - before}, expected 120000`)
    return 'create and execute rejected while paused; cancel refunded 0.0012 tORC in full; unpaused'
  })

  // ================================================================ oracle protection
  await scenario('oracle: stale, future-dated, mismatched-round, non-positive and reverting feeds are all rejected; funds stay recoverable', async () => {
    await healthy()
    const price = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'currentPrice', args: [TORC] })
    if (price[0] !== 100n * 10n ** 18n) throw new Error(`healthy price ${price[0]}`)
    const id = await createTorcSell(120_000n)
    const before = await bal(TORC, trader.address)
    const create = [{ base: TORC, side: 1, orderType: 0, amountIn: 120_000n, triggerPrice: 90n * 10n ** 18n, limitPrice: 0n, trailBps: 0, maxSlippageBps: 300, expiry: Number(await chainNow()) + 3600 }]
    const notes: string[] = []
    const now = await chainNow()
    const bad: [string, bigint, bigint, bigint, bigint, RegExp][] = [
      ['stale (2 min old, 60 s limit)', 100_00_000_000n, now - 120n, 20n, 20n, EXPECT.stale],
      ['future-dated (+2 h)', 100_00_000_000n, now + 7200n, 21n, 21n, EXPECT.stale],
      ['answeredInRound < roundId', 100_00_000_000n, now, 23n, 22n, EXPECT.stale],
      ['zero answer', 0n, now, 24n, 24n, EXPECT.invalid],
      ['negative answer', -5n, now, 25n, 25n, EXPECT.invalid],
    ]
    for (const [label, answer, ts, round, answered, match] of bad) {
      await setFeed(answer, ts, round, answered)
      notes.push(await o(trader, 'createOrder', create, match, `${label}: createOrder`))
      await o(deployer, 'execute', [id, ROUTER_A, '0x'], match, `${label}: execute`)
      const check = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'checkOrder', args: [id] })
      if (check[0] || check[1] !== 4) throw new Error(`${label}: checkOrder returned ${check[0]}/${check[1]}, expected not executable / reason 4`)
    }
    await send(deployer, ORC_FEED, feedAbi, 'setBroken', [true])
    notes.push(await o(trader, 'createOrder', create, EXPECT.invalid, 'reverting feed: createOrder'))
    const brokenCheck = await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'checkOrder', args: [id] })
    if (brokenCheck[0] || brokenCheck[1] !== 4) throw new Error('checkOrder must report oracle unavailable (4) for a reverting feed')
    // The oracle is dead, yet the owner can still get every token back.
    await send(trader, ORDERS, ordersAbi as unknown as Abi, 'cancelOrder', [id])
    const after = await bal(TORC, trader.address)
    if (after !== before + 120_000n) throw new Error(`refund ${after - before}`)
    await send(deployer, ORC_FEED, feedAbi, 'setBroken', [false])
    await healthy()
    const ok = await createTorcSell(120_000n)
    await send(trader, ORDERS, ordersAbi as unknown as Abi, 'cancelOrder', [ok])
    return `6 bad feed states rejected on createOrder and execute, checkOrder reports reason 4; cancel refunded with a dead oracle; recovery to a healthy feed works`
  })

  // ================================================================ router allowlist and hostile calldata
  await scenario('router allowlist: unknown targets, tokens, partial spends, wrong output and garbage calldata are rejected', async () => {
    // Give both routers a feed for tORC so a real, allowlisted router can price it (they pay USDC from their own balance).
    await send(deployer, ROUTER_A, routerAbi, 'setFeed', [TORC, ORC_FEED])
    await send(deployer, ROUTER_B, routerAbi, 'setFeed', [TORC, ORC_FEED])
    await healthy()
    const amount = 120_000n // 0.0012 tORC = $0.12 at $100
    const id = await createTorcSell(amount)
    const escrowBefore = await bal(TORC, ORDERS)
    const swap = (_to: Address, tIn: Address, tOut: Address, amt: bigint) => encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [tIn, tOut, amt] }) as Hex
    const notes: string[] = []
    const run = (label: string, target: Address, data: Hex, match: RegExp) => o(deployer, 'execute', [id, target, data], match, label)

    notes.push(await run('random address as target', '0x000000000000000000000000000000000000dEaD', swap(ROUTER_B, TORC, USDC, amount), EXPECT.notAllowed))
    notes.push(await run('a token as target', TORC, swap(ROUTER_B, TORC, USDC, amount), EXPECT.notAllowed))
    notes.push(await run('the orders contract as target', ORDERS, '0x', EXPECT.notAllowed))
    notes.push(await run('allowlisted router, half the input (partial fill)', ROUTER_B, swap(ROUTER_B, TORC, USDC, amount / 2n), /PartialFill/))
    notes.push(await run('allowlisted router, output sent as a different token', ROUTER_B, swap(ROUTER_B, TORC, TSOL.address as Address, amount), /InsufficientOutput|InvalidBalanceDelta/))
    notes.push(await run('allowlisted router, garbage calldata', ROUTER_B, '0xdeadbeef', /SwapFailed|reverted|0x/))

    // Nothing above moved a single token: the order is open and the escrow is intact.
    const state = await orderOf(id)
    if (state.status !== 0) throw new Error(`order status ${state.status} after failed executions, expected OPEN`)
    if ((await bal(TORC, ORDERS)) !== escrowBefore) throw new Error('escrow changed during failed executions')
    if ((await pub.readContract({ address: TORC, abi: erc20Abi, functionName: 'allowance', args: [ORDERS, ROUTER_B] })) !== 0n) throw new Error('standing allowance to the router')

    // The honest calldata still works, pays the owner and the caller's fee, and leaves no approval behind.
    const traderUsdcBefore = await bal(USDC, trader.address)
    const exec = await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'execute', [id, ROUTER_B, swap(ROUTER_B, TORC, USDC, amount)])
    const done = await orderOf(id)
    if (done.status !== 1) throw new Error('honest execution did not execute')
    if ((await bal(USDC, trader.address)) - traderUsdcBefore !== done.amountOut) throw new Error('owner proceeds differ from recorded net')
    if ((await pub.readContract({ address: TORC, abi: erc20Abi, functionName: 'allowance', args: [ORDERS, ROUTER_B] })) !== 0n) throw new Error('standing allowance after execution')
    if ((await bal(TORC, ORDERS)) !== escrowBefore - amount) throw new Error('escrow not fully released')
    return `${notes.length} hostile executions rejected (order stayed OPEN, escrow and allowances untouched); honest execution through router B paid ${Number(done.amountOut) / 1e6} USDC to the owner (tx ${exec.slice(0, 12)}...)`
  })

  await scenario('router disable is instant and owner-only, and the keeper fails over to the other allowlisted router', async () => {
    await o(outsider, 'disableSwapTarget', [ROUTER_A], EXPECT.notOwner, 'outsider disables a router')
    const disableTx = await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'disableSwapTarget', [ROUTER_A])
    if (await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'swapTargets', args: [ROUTER_A] })) throw new Error('router A still allowlisted')
    if (!(await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'swapTargets', args: [ROUTER_B] }))) throw new Error('router B should still be allowlisted')
    // Router A is now rejected even with perfectly good calldata.
    await healthy()
    const probe = await createTorcSell(120_000n)
    await o(deployer, 'execute', [probe, ROUTER_A, encodeFunctionData({ abi: routerAbi, functionName: 'swapExactIn', args: [TORC, USDC, 120_000n] })], EXPECT.notAllowed, 'execute through the disabled router')
    await send(trader, ORDERS, ordersAbi as unknown as Abi, 'cancelOrder', [probe])

    // Start a keeper that knows both routers; it must route through B.
    const keeperEnv = { ...process.env, KEEPER_ENABLED: 'true', KEEPER_INTERVAL_MS: '3000', INDEXER_ENABLED: 'false', API_PORT: '3022', GATEWAY_PROVIDERS: 'test-router,test-router-b' }
    const keeper = Bun.spawn(['bun', 'run', 'server/index.ts'], { env: keeperEnv, stdout: 'ignore', stderr: 'ignore' })
    try {
      await sleep(8000)
      const tEthFeed = TETH.feed as Address
      const cur = (await pub.readContract({ address: ORDERS, abi: ordersAbi, functionName: 'currentPrice', args: [TETH.address as Address] }))[0]
      await send(trader, TETH.address as Address, tokenAbi, 'faucet')
      await send(trader, TETH.address as Address, erc20Abi as unknown as Abi, 'approve', [ORDERS, 2n ** 255n])
      const amt = parseUnits(process.env.E2E_ETH ?? '0.00018', 18)
      await send(trader, ORDERS, ordersAbi as unknown as Abi, 'createOrder', [
        { base: TETH.address, side: 1, orderType: 0, amountIn: amt, triggerPrice: (cur * 103n) / 100n, limitPrice: 0n, trailBps: 0, maxSlippageBps: 300, expiry: Number(await chainNow()) + 3600 },
      ])
      const id = await nextId()
      const feedNow = (await pub.readContract({ address: tEthFeed, abi: [{ type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] }] as const, functionName: 'latestRoundData' }))[1]
      await send(deployer, tEthFeed, priceFeedAbi as unknown as Abi, 'setPrice', [(feedNow * 106n) / 100n])
      const end = Date.now() + 120_000
      let done = await orderOf(id)
      while (done.status === 0 && Date.now() < end) {
        await sleep(3000)
        done = await orderOf(id)
      }
      if (done.status !== 1) throw new Error('the keeper did not execute the order after router A was disabled')
      const logs = parseEventLogs({ abi: ordersAbi, logs: await pub.getLogs({ address: ORDERS, fromBlock: (await pub.getBlockNumber()) - 600n }), eventName: 'OrderExecuted' }).filter((l) => (l.args as { id: bigint }).id === id)
      const txHash = logs[0]?.transactionHash as Hex
      const receipt = await pub.getTransactionReceipt({ hash: txHash })
      const viaB = receipt.logs.some((l) => l.address.toLowerCase() === ROUTER_B.toLowerCase())
      const viaA = receipt.logs.some((l) => l.address.toLowerCase() === ROUTER_A.toLowerCase())
      if (!viaB || viaA) throw new Error(`execution did not go through router B (viaB=${viaB}, viaA=${viaA})`)
      sent.push({ fn: 'keeper execute (router B)', hash: txHash })
    } finally {
      keeper.kill()
    }
    // Re-enabling is timelocked: queue it so the harness can be restored after the delay.
    const queueHash = await send(deployer, ORDERS, ordersAbi as unknown as Abi, 'queueSwapTarget', [ROUTER_A, true])
    const rc = await pub.getTransactionReceipt({ hash: queueHash })
    const ev = parseEventLogs({ abi: ordersAbi, logs: rc.logs, eventName: 'ConfigQueued' })[0].args as { changeId: Hex; eta: bigint }
    const rec = JSON.parse(await readFile('src/trading/testnet-harness.json', 'utf8')) as { queuedConfig: { label: string; changeId: Hex; eta: number }[] }
    rec.queuedConfig.push({ label: 'swap router A re-enable', changeId: ev.changeId, eta: Number(ev.eta) })
    await writeFile('src/trading/testnet-harness.json', JSON.stringify(rec, null, 2) + '\n')
    return `disableSwapTarget took effect at once (tx ${disableTx.slice(0, 12)}...); outsider rejected; router A rejected with good calldata; the keeper executed a fresh order through router B; re-enable of A queued (timelocked)`
  })

  // Return what is left to the deployer (testnet USDC is scarce).
  try {
    for (const w of [trader, outsider]) {
      const left = await pub.getBalance({ address: w.address })
      const reserve = parseUnits('0.01', 18)
      if (left > reserve) {
        const hash = await wallet(w).sendTransaction({ to: deployer.address, value: left - reserve })
        await pub.waitForTransactionReceipt({ hash })
        console.log(`swept ${Number(left - reserve) / 1e18} USDC from ${w.address.slice(0, 8)}... back to the deployer`)
      }
    }
  } catch (e) {
    console.log(`sweep skipped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }

  // ================================================================ report
  const failed = results.filter((r) => !r.ok)
  await mkdir('docs/test-reports', { recursive: true })
  await writeFile(
    'docs/test-reports/e2e-security.json',
    JSON.stringify({ label: 'security', chainId: arcTestnet.id, orders: ORDERS, owner: deployer.address, trader: trader.address, ranAt: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2) + '\n',
  )
  console.log(`\n${results.length - failed.length}/${results.length} security scenarios passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
