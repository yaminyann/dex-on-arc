/**
 * Deploys the TESTNET-ONLY trading harness to Arc Testnet and a fresh order contract owned by the
 * deployer key, then queues the oracle and swap-target configuration (which the order contract
 * delays by its timelock). Writes the public addresses to src/trading/testnet-harness.json.
 *
 *   bun run server/testnet/deploy-harness.ts
 *
 * Needs TESTNET_DEPLOYER_PRIVATE_KEY in .env (a throwaway key funded with Arc Testnet USDC for gas).
 * Never run this against mainnet: the harness has no access control on its price feeds.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '../../src/onchain-facts'

const key = process.env.TESTNET_DEPLOYER_PRIVATE_KEY as Hex | undefined
if (!key) throw new Error('TESTNET_DEPLOYER_PRIVATE_KEY is not set in .env')

const rpc = getChain(arcTestnet.id)?.rpcUrls[0]
const usdc = getUsdc(arcTestnet.id)?.address as Address | undefined
if (!rpc || !usdc) throw new Error('Arc Testnet facts missing')
const USDC: Address = usdc

const account = privateKeyToAccount(key)
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })

async function artifact(file: string, name: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const j = (await Bun.file(`contracts/out/${file}.sol/${name}.json`).json()) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: j.abi, bytecode: j.bytecode.object }
}

async function deployWithTx(file: string, name: string, args: unknown[]): Promise<{ address: Address; hash: Hex }> {
  const { abi, bytecode } = await artifact(file, name)
  const hash = await wallet.deployContract({ abi, bytecode, args })
  const r = await publicClient.waitForTransactionReceipt({ hash })
  if (!r.contractAddress) throw new Error(`${name} deploy failed`)
  console.log(`${name} -> ${r.contractAddress}`)
  return { address: r.contractAddress, hash }
}

async function deploy(file: string, name: string, args: unknown[]): Promise<Address> {
  return (await deployWithTx(file, name, args)).address
}

async function send(address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ address, abi, functionName, args })
  await publicClient.waitForTransactionReceipt({ hash })
}

async function refPrice(product: string): Promise<number> {
  const r = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`)
  const j = (await r.json()) as { price?: string }
  const p = Number(j.price)
  if (!Number.isFinite(p) || p <= 0) throw new Error(`No reference price for ${product}`)
  return p
}

const feedPrice = (p: number) => BigInt(Math.round(p * 1e8))

const ASSETS = [
  { symbol: 'tBTC', name: 'Test Bitcoin', decimals: 8, faucet: '1', product: 'BTC-USD' },
  { symbol: 'tETH', name: 'Test Ether', decimals: 18, faucet: '10', product: 'ETH-USD' },
  { symbol: 'tSOL', name: 'Test Solana', decimals: 9, faucet: '100', product: 'SOL-USD' },
] as const

async function main() {
  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`deployer ${account.address} native balance ${balance}`)

  const ordersArt = await artifact('ArcTradeOrders', 'ArcTradeOrders')
  const { address: orders, hash: ordersDeployTx } = await deployWithTx('ArcTradeOrders', 'ArcTradeOrders', [account.address, USDC, 3600])

  const router = await deploy('TestSwapRouter', 'TestSwapRouter', [account.address])
  const routerArt = await artifact('TestSwapRouter', 'TestSwapRouter')
  const tokenArt = await artifact('TestToken', 'TestToken')

  const usdcFeed = await deploy('TestPriceFeed', 'TestPriceFeed', ['USDC / USD (test feed)', 1e8])
  await send(router, routerArt.abi, 'setFeed', [USDC, usdcFeed])

  const assets: Record<string, unknown>[] = []
  // Queue config via logs so the exact change ids are known.
  const queued: { label: string; changeId: Hex; eta: bigint }[] = []
  const queueAndRecord = async (label: string, fn: 'queueTokenConfig' | 'queueSwapTarget', args: unknown[]) => {
    const hash = await wallet.writeContract({ address: orders, abi: ordersArt.abi, functionName: fn, args })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    const ev = ordersArt.abi.find((x) => x.type === 'event' && x.name === 'ConfigQueued')
    const logs = await publicClient.getLogs({ address: orders, event: ev as never, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber })
    const a = (logs[logs.length - 1] as unknown as { args: { changeId: Hex; eta: bigint } }).args
    queued.push({ label, changeId: a.changeId, eta: a.eta })
  }

  await queueAndRecord('USDC feed', 'queueTokenConfig', [USDC, usdcFeed, 172800])

  for (const a of ASSETS) {
    const token = await deploy('TestToken', 'TestToken', [a.name, a.symbol, a.decimals, parseUnits(a.faucet, a.decimals), account.address])
    const price = await refPrice(a.product)
    const feed = await deploy('TestPriceFeed', 'TestPriceFeed', [`${a.symbol} / USD (test feed)`, feedPrice(price)])
    await send(token, tokenArt.abi, 'setMinter', [router])
    await send(router, routerArt.abi, 'setFeed', [token, feed])
    await queueAndRecord(`${a.symbol} feed`, 'queueTokenConfig', [token, feed, 172800])
    assets.push({ symbol: a.symbol, name: a.name, decimals: a.decimals, address: token, feed, faucetAmount: a.faucet, referenceProduct: a.product, initialPrice: price })
  }
  await queueAndRecord('swap router', 'queueSwapTarget', [router, true])

  // Seed the router with USDC so it can pay out sells. Keep a gas reserve on the deployer.
  const usdcBal = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }))
  const reserve = parseUnits('6', 6)
  if (usdcBal > reserve) {
    const hash = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [router, usdcBal - reserve] })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`seeded router with ${usdcBal - reserve} USDC base units`)
  }

  const out = {
    network: 'arc-testnet',
    chainId: arcTestnet.id,
    deployer: account.address,
    orders,
    ordersDeployTx,
    router,
    usdcFeed,
    assets,
    queuedConfig: queued.map((q) => ({ label: q.label, changeId: q.changeId, eta: Number(q.eta) })),
    deployedAt: new Date().toISOString(),
  }
  await Bun.write('src/trading/testnet-harness.json', JSON.stringify(out, null, 2) + '\n')
  console.log('wrote src/trading/testnet-harness.json')
  console.log(`config can be applied after ${new Date(Math.max(...queued.map((q) => Number(q.eta))) * 1000).toISOString()}`)
}

await main()
