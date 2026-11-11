/**
 * Applies the queued oracle and swap-target configuration on the testnet order contract once its
 * timelock has passed. Safe to run repeatedly: applied entries are skipped.
 *
 *   bun run server/testnet/apply-config.ts
 */
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { getChain } from '../../src/onchain-facts'
import { ordersAbi } from '../../src/trading/ordersAbi'
import harness from '../../src/trading/testnet-harness.json'

const key = process.env.TESTNET_DEPLOYER_PRIVATE_KEY as Hex | undefined
if (!key) throw new Error('TESTNET_DEPLOYER_PRIVATE_KEY is not set in .env')
const rpc = getChain(arcTestnet.id)?.rpcUrls[0]
if (!rpc) throw new Error('Arc Testnet RPC missing from facts')

const account = privateKeyToAccount(key)
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })
const orders = harness.orders as Hex

for (const q of harness.queuedConfig) {
  const eta = await publicClient.readContract({ address: orders, abi: ordersAbi, functionName: 'pendingConfigEta', args: [q.changeId as Hex] })
  if (eta === 0n) {
    console.log(`${q.label}: already applied`)
    continue
  }
  const now = Math.floor(Date.now() / 1000)
  if (now < Number(eta)) {
    console.log(`${q.label}: not ready, ${Number(eta) - now}s remaining`)
    continue
  }
  const hash = await wallet.writeContract({ address: orders, abi: ordersAbi, functionName: 'applyConfig', args: [q.changeId as Hex] })
  await publicClient.waitForTransactionReceipt({ hash })
  console.log(`${q.label}: applied (${hash})`)
}
