/**
 * Checks an env file before you deploy. Reads the same variables docker-compose.yml uses and, where it
 * can, asks the chain: is there code at the order contract, who owns it, does the keeper wallet have gas.
 *
 *   bun run scripts/coolify/preflight.ts deploy/coolify/production.env
 *
 * Exit code 1 when something must be fixed before deploying. Warnings do not fail the run.
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, formatUnits, http, isAddress, type Address, type Hex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { arc, arcTestnet } from 'viem/chains'
import { parsePlatformFee } from '../../server/gateway/fee'
import { ordersAbi } from '../../src/trading/ordersAbi'

const file = process.argv[2]
if (!file) {
  console.error('Usage: bun run scripts/coolify/preflight.ts <env file>')
  process.exit(2)
}

const env: Record<string, string> = {}
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

let errors = 0
const ok = (m: string) => console.log(`  ok    ${m}`)
const warn = (m: string) => console.log(`  WARN  ${m}`)
const bad = (m: string) => {
  errors++
  console.log(`  FAIL  ${m}`)
}

const network = env.VITE_DEFAULT_NETWORK === 'arc' ? 'arc' : 'arc-testnet'
const isMain = network === 'arc'
const chain = isMain ? arc : arcTestnet
console.log(`Preflight for ${file} (${isMain ? 'MAINNET' : 'testnet'})`)

// --- secrets and basics
if ((env.ADMIN_TOKEN ?? '').length >= 24) ok('ADMIN_TOKEN is set and long enough')
else bad('ADMIN_TOKEN must be at least 24 characters')

if (env.KEEPER_NETWORK !== network) bad(`KEEPER_NETWORK (${env.KEEPER_NETWORK || 'unset'}) must match VITE_DEFAULT_NETWORK (${network})`)
if (env.INDEXER_NETWORK !== network) warn(`INDEXER_NETWORK (${env.INDEXER_NETWORK || 'unset'}) differs from ${network}`)
if (env.INDEXER_ENABLED !== 'true') warn('INDEXER_ENABLED is not true: the admin page cannot list tokens, routers or queued changes')
if ((env.TRUSTED_PROXY_HOPS ?? '') === '0') warn('TRUSTED_PROXY_HOPS=0 makes every user share one rate-limit bucket behind the proxy; use 2')
if (!env.ALLOWED_ORIGINS) warn('ALLOWED_ORIGINS is empty: any website can call your quote service')

// --- fee
const fee = parsePlatformFee(env)
if (fee.problem) bad(fee.problem)
else if (fee.fee) ok(`platform fee ${fee.fee.bps / 100}% to ${fee.fee.recipient}`)
else ok('platform fee is off')

// --- chain checks
const rpc = (isMain ? env.RPC_URL_Arc : env.RPC_URL_Arc_Testnet)?.split(',')[0]?.trim() || chain.rpcUrls.default.http[0]
const client = createPublicClient({ chain, transport: http(rpc, { timeout: 10_000 }) })
try {
  const id = await client.getChainId()
  if (id !== chain.id) bad(`RPC ${rpc} is chain ${id}, expected ${chain.id}`)
  else ok(`RPC answers for chain ${id}`)

  const orders = (isMain ? env.VITE_ORDERS_ADDRESS_ARC_MAINNET : env.VITE_ORDERS_ADDRESS_ARC_TESTNET) as Address | undefined
  if (!orders) {
    if (isMain) warn('no mainnet order contract set: market swaps work, orders and DCA are disabled until you deploy and set VITE_ORDERS_ADDRESS_ARC_MAINNET')
    else bad('VITE_ORDERS_ADDRESS_ARC_TESTNET is empty')
  } else if (!isAddress(orders)) bad('order contract address is not a valid address')
  else {
    const code = await client.getCode({ address: orders })
    if (!code || code === '0x') bad(`no contract code at ${orders} on this network`)
    else {
      const owner = await client.readContract({ address: orders, abi: ordersAbi, functionName: 'owner' })
      const paused = await client.readContract({ address: orders, abi: ordersAbi, functionName: 'paused' })
      const delay = await client.readContract({ address: orders, abi: ordersAbi, functionName: 'configDelay' })
      ok(`order contract found, owner ${owner}${paused ? ' (PAUSED)' : ''}, config delay ${Number(delay) / 3600} h`)
      if (isMain && Number(delay) < 48 * 3600) warn('mainnet config delay is under 48 hours (see docs/mainnet-readiness-checklist.md)')
      if (!env.VITE_ORDERS_DEPLOY_TX_ARC_TESTNET && !isMain) warn('deploy tx not set: the indexer will start from the last 50,000 blocks only')
      if (env.KEEPER_PRIVATE_KEY && privateKeyToAddress(env.KEEPER_PRIVATE_KEY as Hex).toLowerCase() === owner.toLowerCase()) {
        bad('the keeper key is the contract owner key. Use a separate low-balance wallet')
      }
    }
  }

  if (env.KEEPER_ENABLED === 'true') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(env.KEEPER_PRIVATE_KEY ?? '')) bad('KEEPER_ENABLED=true needs KEEPER_PRIVATE_KEY (0x + 64 hex)')
    else {
      const addr = privateKeyToAddress(env.KEEPER_PRIVATE_KEY as Hex)
      const bal = await client.getBalance({ address: addr })
      const usdc = Number(formatUnits(bal, 18))
      if (usdc < 1) warn(`keeper ${addr} holds ${usdc.toFixed(4)} USDC; fund it (gas) so executions keep running`)
      else ok(`keeper ${addr} holds ${usdc.toFixed(2)} USDC for gas`)
    }
  } else warn('KEEPER_ENABLED is not true: orders and DCA will not execute until a keeper runs somewhere')
} catch (e) {
  bad(`chain check failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
}

console.log(errors === 0 ? '\nPreflight passed.' : `\n${errors} problem(s) to fix before deploying.`)
process.exit(errors === 0 ? 0 : 1)
