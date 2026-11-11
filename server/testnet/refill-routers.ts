/**
 * Tops up the test routers' USDC so they can pay out sells during the live tests. The routers pay outputs
 * from their own balance, and every full test run drains them (traders receive the proceeds). Funds come
 * from the deployer and the keeper wallet, each keeping a gas reserve.
 *
 *   bun run server/testnet/refill-routers.ts A=4 B=2.5
 *
 * Testnet USDC comes from a captcha-gated faucet, so this only moves what the project wallets already hold.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '../../src/onchain-facts'
import harness from '../../src/trading/testnet-harness.json'

const rpc = process.env.RPC_URL_Arc_Testnet ?? getChain(arcTestnet.id)?.rpcUrls[0]
const USDC = getUsdc(arcTestnet.id)?.address as Address
if (!rpc || !USDC) throw new Error('Arc Testnet facts missing')
const targets = new Map<string, number>()
for (const a of process.argv.slice(2)) {
  const [k, v] = a.split('=')
  targets.set(k.toUpperCase(), Number(v))
}
const h = harness as { router: Address; routerB?: Address }
const routers: [string, Address | undefined][] = [['A', h.router], ['B', h.routerB]]

const transport = http(rpc)
const pub = createPublicClient({ chain: arcTestnet, transport })
const keys = [process.env.TESTNET_DEPLOYER_PRIVATE_KEY, process.env.KEEPER_PRIVATE_KEY].filter((k): k is Hex => Boolean(k))
const sources = keys.map((k) => privateKeyToAccount(k))
const RESERVE = parseUnits(process.env.REFILL_RESERVE ?? '0.6', 6)

for (const [label, address] of routers) {
  const want = targets.get(label)
  if (want === undefined || !address) continue
  let need = parseUnits(String(want), 6) - (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] }))
  for (const src of sources) {
    if (need <= 0n) break
    const have = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [src.address] })
    const give = have > RESERVE ? (have - RESERVE < need ? have - RESERVE : need) : 0n
    if (give <= 0n) continue
    const hash = await createWalletClient({ account: src, chain: arcTestnet, transport }).writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [address, give] })
    await pub.waitForTransactionReceipt({ hash })
    need -= give
    console.log(`router ${label} +${Number(give) / 1e6} USDC (${hash})`)
  }
  const now = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
  console.log(`router ${label} balance ${Number(now) / 1e6} USDC${need > 0n ? ` (short by ${Number(need) / 1e6}: the wallets have no more to give)` : ''}`)
}
