/**
 * Deploys the oracle-protection test fixtures on Arc Testnet: a test token (tORC) and a fully controllable
 * feed (TestControllableFeed), and queues them as a token config on the v2 order contract with the minimum
 * staleness (60 s). After the config delay `apply-config.ts` applies it and `e2e-security.ts` can drive the
 * feed into stale, mismatched-round, non-positive, future-dated and reverting states.
 *
 *   bun run server/testnet/deploy-oracle-test.ts
 *
 * Needs TESTNET_DEPLOYER_PRIVATE_KEY and `forge build`. Testnet only.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createPublicClient, createWalletClient, http, parseUnits, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain } from '../../src/onchain-facts'
import harness from '../../src/trading/testnet-harness.json'

const key = process.env.TESTNET_DEPLOYER_PRIVATE_KEY as Hex | undefined
if (!key) throw new Error('TESTNET_DEPLOYER_PRIVATE_KEY is not set in .env')
const rpc = process.env.RPC_URL_Arc_Testnet ?? getChain(arcTestnet.id)?.rpcUrls[0]
if (!rpc) throw new Error('Arc Testnet RPC missing')

const account = privateKeyToAccount(key)
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })
const h = harness as Record<string, unknown> & { orders: Address; oracleTest?: unknown; queuedConfig: { label: string; changeId: Hex; eta: number }[] }
if (h.oracleTest) {
  console.log('oracle test fixtures already recorded; nothing to do')
  process.exit(0)
}

async function artifact(file: string, name: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const j = JSON.parse(await readFile(`contracts/out/${file}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: j.abi, bytecode: j.bytecode.object }
}
async function deploy(file: string, name: string, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = await artifact(file, name)
  const hash = await wallet.deployContract({ abi, bytecode, args })
  const r = await publicClient.waitForTransactionReceipt({ hash })
  if (!r.contractAddress) throw new Error(`${name} deploy failed`)
  console.log(`${name} -> ${r.contractAddress}`)
  return r.contractAddress
}

const feed = await deploy('TestControllableFeed', 'TestControllableFeed', [100_00_000_000n]) // $100.00
const token = await deploy('TestToken', 'TestToken', ['Test Oracle Token', 'tORC', 8, parseUnits('1', 8), account.address])

const orders = await artifact('ArcTradeOrders', 'ArcTradeOrders')
const hash = await wallet.writeContract({ address: h.orders, abi: orders.abi, functionName: 'queueTokenConfig', args: [token, feed, 60] })
const receipt = await publicClient.waitForTransactionReceipt({ hash })
const ev = orders.abi.find((x) => x.type === 'event' && x.name === 'ConfigQueued')
const logs = await publicClient.getLogs({ address: h.orders, event: ev as never, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber })
const a = (logs[logs.length - 1] as unknown as { args: { changeId: Hex; eta: bigint } }).args

h.queuedConfig.push({ label: 'oracle test token feed (tORC, 60s staleness)', changeId: a.changeId, eta: Number(a.eta) })
h.oracleTest = { token, feed, queueTx: hash }
await writeFile('src/trading/testnet-harness.json', JSON.stringify(h, null, 2) + '\n')
console.log(`queued; apply after ${new Date(Number(a.eta) * 1000).toISOString()} with bun run server/testnet/apply-config.ts`)
