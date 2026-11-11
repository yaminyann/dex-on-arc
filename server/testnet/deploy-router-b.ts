/**
 * Deploys a SECOND TestSwapRouter on Arc Testnet and queues it as a swap target on the harness order
 * contract (timelocked). It exists to rehearse, on testnet, what mainnet needs for each extra
 * aggregator router: an onchain allowlist entry the keeper can use, selected by the quote gateway.
 *
 *   bun run server/testnet/deploy-router-b.ts
 *   ... wait for the config delay ...
 *   bun run server/testnet/apply-config.ts
 *
 * Idempotent: if src/trading/testnet-harness.json already has a routerB it only (re)checks funding.
 * The router pays outputs from its own balance (the test tokens have a single minter, router A), so it
 * is funded with a small amount of USDC and test tokens taken from the deployer's faucet allowance.
 * Needs TESTNET_DEPLOYER_PRIVATE_KEY. Never run against mainnet.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '../../src/onchain-facts'
import { ordersAbi } from '../../src/trading/ordersAbi'
import harness from '../../src/trading/testnet-harness.json'

const key = process.env.TESTNET_DEPLOYER_PRIVATE_KEY as Hex | undefined
if (!key) throw new Error('TESTNET_DEPLOYER_PRIVATE_KEY is not set in .env')
const rpc = process.env.RPC_URL_Arc_Testnet ?? getChain(arcTestnet.id)?.rpcUrls[0]
const usdc = getUsdc(arcTestnet.id)?.address as Address | undefined
if (!rpc || !usdc) throw new Error('Arc Testnet facts missing')

const account = privateKeyToAccount(key)
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })
const orders = harness.orders as Address

async function artifact(file: string, name: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const j = (await Bun.file(`contracts/out/${file}.sol/${name}.json`).json()) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: j.abi, bytecode: j.bytecode.object }
}

async function send(address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ address, abi, functionName, args })
  const r = await publicClient.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted`)
  return r
}

const harnessJson = harness as Record<string, unknown> & { routerB?: Address; queuedConfig: { label: string; changeId: Hex; eta: number }[] }
const routerArt = await artifact('TestSwapRouter', 'TestSwapRouter')

let routerB = harnessJson.routerB
if (!routerB) {
  const hash = await wallet.deployContract({ abi: routerArt.abi, bytecode: routerArt.bytecode, args: [account.address] })
  const r = await publicClient.waitForTransactionReceipt({ hash })
  if (!r.contractAddress) throw new Error('router B deploy failed')
  routerB = r.contractAddress
  console.log(`router B -> ${routerB}`)

  await send(routerB, routerArt.abi, 'setFeed', [usdc, harness.usdcFeed])
  for (const a of harness.assets) await send(routerB, routerArt.abi, 'setFeed', [a.address, a.feed])

  const queueHash = await wallet.writeContract({ address: orders, abi: ordersAbi, functionName: 'queueSwapTarget', args: [routerB, true] })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: queueHash })
  const logs = await publicClient.getLogs({ address: orders, event: ordersAbi.find((x) => x.type === 'event' && x.name === 'ConfigQueued') as never, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber })
  const a = (logs[logs.length - 1] as unknown as { args: { changeId: Hex; eta: bigint } }).args
  harnessJson.routerB = routerB
  harnessJson.queuedConfig.push({ label: 'swap router B', changeId: a.changeId, eta: Number(a.eta) })
  await Bun.write('src/trading/testnet-harness.json', JSON.stringify(harnessJson, null, 2) + '\n')
  console.log(`queued; apply after ${new Date(Number(a.eta) * 1000).toISOString()}`)
}

// Fund router B: a little USDC for sells, and test tokens from the faucet for buys.
const tokenArt = await artifact('TestToken', 'TestToken')
const usdcBal = await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [routerB] })
const target = parseUnits('1.5', 6)
if (usdcBal < target) {
  const mine = await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
  const amount = target - usdcBal
  if (mine > amount + parseUnits('2', 6)) {
    await send(usdc, erc20Abi as unknown as Abi, 'transfer', [routerB, amount])
    console.log(`funded router B with ${amount} USDC base units`)
  } else console.log('deployer USDC too low to fund router B; fund it manually')
}
for (const a of harness.assets) {
  const token = a.address as Address
  const have = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [routerB] })
  if (have > 0n) continue
  const mine = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
  if (mine === 0n) await send(token, tokenArt.abi, 'faucet', [])
  const bal = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
  await send(token, erc20Abi as unknown as Abi, 'transfer', [routerB, bal])
  console.log(`funded router B with ${bal} ${a.symbol} base units`)
}
console.log('done')
