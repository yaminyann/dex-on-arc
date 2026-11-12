/**
 * Writes deploy/coolify/production.env: every variable docker-compose.yml reads, with a fresh random
 * ADMIN_TOKEN, and (optionally) a fresh keeper wallet. Paste the file into Coolify's Environment
 * Variables (Developer view) or keep it next to docker-compose.yml for plain `docker compose`.
 *
 *   bun run scripts/coolify/gen-env.ts                      # testnet, reuses public values from ./.env
 *   bun run scripts/coolify/gen-env.ts --mainnet            # mainnet defaults (no order contract yet)
 *   bun run scripts/coolify/gen-env.ts --new-keeper-key     # also create a dedicated keeper wallet
 *   bun run scripts/coolify/gen-env.ts --out path/to/file.env
 *
 * The output is git-ignored. It contains secrets: do not paste it into chats or commit it.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const value = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const mainnet = flag('--mainnet')
const out = value('--out') ?? 'deploy/coolify/production.env'

/** Public (non-secret) values worth carrying over from the local .env. */
function readLocal(): Record<string, string> {
  if (!existsSync('.env')) return {}
  const map: Record<string, string> = {}
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) map[m[1]] = m[2]
  }
  return map
}
const local = readLocal()
const carry = (k: string, fallback = '') => local[k] || fallback

if (existsSync(out) && !flag('--force')) {
  console.error(`${out} already exists. Re-run with --force to overwrite it (this rotates ADMIN_TOKEN).`)
  process.exit(1)
}

const adminToken = randomBytes(32).toString('hex')
let keeperKey = ''
let keeperAddress = ''
if (flag('--new-keeper-key')) {
  const key = generatePrivateKey()
  keeperKey = key
  keeperAddress = privateKeyToAddress(key)
}
const net = mainnet ? 'arc' : 'arc-testnet'
const keeperNote = keeperKey
  ? `# Keeper wallet address (fund it with a little USDC for gas): ${keeperAddress}\n`
  : '# Use a DEDICATED low-balance wallet. Never reuse the contract owner key.\n'

const lines = `# Arc Terminal - Coolify environment (${mainnet ? 'MAINNET' : 'TESTNET'}). Generated ${new Date().toISOString()}.
# Contains secrets. Paste into Coolify -> Environment Variables -> Developer view. Never commit or share it.

# ---- Required ----------------------------------------------------------------------------------
# Bearer token for /metrics and the admin page's backend status. Keep it secret.
ADMIN_TOKEN=${adminToken}

# ---- Network -----------------------------------------------------------------------------------
# Which network the app opens on, and which one the keeper and indexer watch.
VITE_DEFAULT_NETWORK=${net}
KEEPER_NETWORK=${net}
INDEXER_NETWORK=${net}

# ---- Order contract (public values, baked into the web build) ------------------------------------
VITE_ORDERS_ADDRESS_ARC_TESTNET=${carry('VITE_ORDERS_ADDRESS_ARC_TESTNET')}
VITE_ORDERS_DEPLOY_TX_ARC_TESTNET=${carry('VITE_ORDERS_DEPLOY_TX_ARC_TESTNET')}
# Fill these after YOU deploy ArcTradeOrders on mainnet (see docs/mainnet-readiness-checklist.md).
VITE_ORDERS_ADDRESS_ARC_MAINNET=
VITE_ORDERS_DEPLOY_TX_ARC_MAINNET=
# Extra reviewed swap routers the browser may use on mainnet (comma-separated). Usually empty.
VITE_SWAP_TARGETS_ARC=

# ---- Keeper: the wallet that executes orders and earns the keeper fee ----------------------------
KEEPER_ENABLED=true
${keeperNote}KEEPER_PRIVATE_KEY=${keeperKey}
KEEPER_INTERVAL_MS=5000

# ---- Platform fee on market swaps -----------------------------------------------------------------
# 30 = 0.30% of the sell amount, paid by the aggregator to the recipient inside the swap. 0 = off. Max 100.
PLATFORM_FEE_BPS=0
PLATFORM_FEE_RECIPIENT=

# ---- Quote providers --------------------------------------------------------------------------------
GATEWAY_PROVIDERS=0x,kyber,test-router,test-router-b
# Optional. Without it only KyberSwap answers on mainnet.
ZEROEX_API_KEY=

# ---- RPC (comma-separated = failover in order; empty = public RPC) --------------------------------------
RPC_URL_Arc_Testnet=${carry('RPC_URL_Arc_Testnet', 'https://rpc.testnet.arc.io')}
RPC_URL_Arc=
KEEPER_WS_URL=${carry('KEEPER_WS_URL', mainnet ? '' : 'wss://rpc.testnet.arc.io')}

# ---- Indexer ----------------------------------------------------------------------------------------------
INDEXER_ENABLED=true
INDEXER_INTERVAL_MS=5000
DATABASE_URL=sqlite://./data/indexer.db

# ---- Edge ---------------------------------------------------------------------------------------------------
# Hops between the internet and the api: Coolify proxy + nginx = 2 (add 1 behind Cloudflare).
TRUSTED_PROXY_HOPS=2
# Your public origin, e.g. https://terminal.example.com (blocks other sites from using your quote service).
ALLOWED_ORIGINS=
ALERT_WEBHOOK_URL=
`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, lines, { mode: 0o600 })
console.log(`Wrote ${out}`)
console.log(`  ADMIN_TOKEN        generated (${adminToken.length} chars)`)
if (keeperAddress) console.log(`  KEEPER wallet      ${keeperAddress}  <- fund this address with USDC for gas`)
else console.log('  KEEPER_PRIVATE_KEY empty: set it, or re-run with --new-keeper-key')
console.log(`Next: bun run scripts/coolify/preflight.ts ${out}`)
