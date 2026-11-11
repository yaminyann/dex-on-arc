/**
 * Deploys the v2 order contract to Arc Testnet next to the existing harness (test tokens, test feeds,
 * test routers are reused), queues the same oracle and swap-target configuration on it (timelocked),
 * sets a small minimum order size, and records the new deployment in src/trading/testnet-harness.json.
 * The previous deployment is kept in the record as `ordersV1` so nothing is lost.
 *
 *   bun run server/testnet/deploy-orders-v2.ts
 *   ... wait for the config delay ...
 *   bun run server/testnet/apply-config.ts
 *
 * Needs TESTNET_DEPLOYER_PRIVATE_KEY and `forge build`. Testnet only. v2 is unaudited.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createPublicClient, createWalletClient, http, parseUnits, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '../../src/onchain-facts'
import harness from '../../src/trading/testnet-harness.json'

const key = process.env.TESTNET_DEPLOYER_PRIVATE_KEY as Hex | undefined
if (!key) throw new Error('TESTNET_DEPLOYER_PRIVATE_KEY is not set in .env')
const rpc = process.env.RPC_URL_Arc_Testnet ?? getChain(arcTestnet.id)?.rpcUrls[0]
const usdc = getUsdc(arcTestnet.id)?.address as Address | undefined
if (!rpc || !usdc) throw new Error('Arc Testnet facts missing')

const account = privateKeyToAccount(key)
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })
const h = harness as Record<string, unknown> & { orders: Address; ordersDeployTx: Hex; routerB?: Address; router: Address; usdcFeed: Address; assets: { symbol: string; address: Address; feed: Address }[] }

if ((h as { ordersV1?: Address }).ordersV1) {
  console.log('v2 already recorded in the harness file; nothing to do')
  process.exit(0)
}

const art = JSON.parse(await readFile('contracts/out/ArcTradeOrders.sol/ArcTradeOrders.json', 'utf8')) as { abi: Abi; bytecode: { object: Hex } }

const deployHash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [account.address, usdc, 3600] })
const deployed = await publicClient.waitForTransactionReceipt({ hash: deployHash })
if (!deployed.contractAddress) throw new Error('deploy failed')
const orders = deployed.contractAddress
console.log(`ArcTradeOrders v2 -> ${orders}`)

const queued: { label: string; changeId: Hex; eta: number }[] = []
async function queue(label: string, functionName: 'queueTokenConfig' | 'queueSwapTarget', args: unknown[]) {
  const hash = await wallet.writeContract({ address: orders, abi: art.abi, functionName, args })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  const ev = art.abi.find((x) => x.type === 'event' && x.name === 'ConfigQueued')
  const logs = await publicClient.getLogs({ address: orders, event: ev as never, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber })
  const a = (logs[logs.length - 1] as unknown as { args: { changeId: Hex; eta: bigint } }).args
  queued.push({ label, changeId: a.changeId, eta: Number(a.eta) })
  console.log(`queued ${label}`)
}

await queue('USDC feed', 'queueTokenConfig', [usdc, h.usdcFeed, 172800])
for (const a of h.assets) await queue(`${a.symbol} feed`, 'queueTokenConfig', [a.address, a.feed, 172800])
await queue('swap router', 'queueSwapTarget', [h.router, true])
if (h.routerB) await queue('swap router B', 'queueSwapTarget', [h.routerB, true])

// Dust floor: 0.1 USDC keeps spam out while leaving the end-to-end test amounts valid.
const minHash = await wallet.writeContract({ address: orders, abi: art.abi, functionName: 'setMinOrderQuote', args: [parseUnits('0.1', 6)] })
await publicClient.waitForTransactionReceipt({ hash: minHash })
console.log('minimum order size set to 0.1 USDC')

const next = { ...h, ordersV1: h.orders, ordersV1DeployTx: h.ordersDeployTx, orders, ordersDeployTx: deployHash, queuedConfig: queued, deployedAt: new Date().toISOString() }
await writeFile('src/trading/testnet-harness.json', JSON.stringify(next, null, 2) + '\n')
console.log(`recorded. Apply the config after ${new Date(Math.max(...queued.map((q) => q.eta)) * 1000).toISOString()}: bun run server/testnet/apply-config.ts`)
