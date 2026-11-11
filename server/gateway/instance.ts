/** The process-wide gateway, built from environment. Shared by the HTTP API and the keeper. */
import { erc20Abi, type Address, type Hex } from 'viem'
import harness from '../../src/trading/testnet-harness.json'
import { publicClientFor } from '../rpc'
import { Gateway } from './gateway'
import { createKyberProvider } from './kyber'
import { createTestRouterProvider, viemTestRouterReader } from './testrouter'
import type { QuoteProvider } from './types'
import { zeroExProvider } from './zeroex'

const ARC_MAINNET = 5042
const ARC_TESTNET = 5042002
const USDC = '0x3600000000000000000000000000000000000000'

export async function readAllowance(chainId: number, token: string, owner: string, spender: string): Promise<bigint> {
  return publicClientFor(chainId).readContract({ address: token as Address, abi: erc20Abi, functionName: 'allowance', args: [owner as Address, spender as Address] })
}

function enabledIds(): Set<string> {
  const raw = process.env.GATEWAY_PROVIDERS
  return new Set((raw ? raw.split(',') : ['0x', 'kyber', 'test-router', 'test-router-b']).map((s) => s.trim().toLowerCase()).filter(Boolean))
}

/** Testnet-only routers from the harness record. They support chain 5042002 only, so they never answer on mainnet. */
function testRouters(): QuoteProvider[] {
  const reader = viemTestRouterReader({ readContract: (args) => publicClientFor(ARC_TESTNET).readContract(args as never) })
  const h = harness as { router?: string; routerB?: string }
  const out: QuoteProvider[] = []
  if (h.router) out.push(createTestRouterProvider({ id: 'test-router', router: h.router as Address, chainId: ARC_TESTNET, reader }))
  if (h.routerB) out.push(createTestRouterProvider({ id: 'test-router-b', router: h.routerB as Address, chainId: ARC_TESTNET, reader }))
  return out
}

export function buildGateway(): Gateway {
  const enabled = enabledIds()
  const kyber = createKyberProvider({ readAllowance })
  const providers: QuoteProvider[] = [zeroExProvider, kyber, ...testRouters()].filter((p) => enabled.has(p.id))
  return new Gateway(providers, {
    timeoutMs: Number(process.env.GATEWAY_TIMEOUT_MS ?? 4000) || 4000,
    breakerThreshold: Number(process.env.GATEWAY_BREAKER_THRESHOLD ?? 3) || 3,
    breakerCooldownMs: Number(process.env.GATEWAY_BREAKER_COOLDOWN_MS ?? 30_000) || 30_000,
    budgetPerMin: Math.max(1, Math.floor(Number(process.env.UPSTREAM_BUDGET_PER_MIN ?? 600)) || 600),
    usdc: { [ARC_MAINNET]: USDC, [ARC_TESTNET]: USDC },
    // An eth_call from the taker catches stale or mis-built calldata before the wallet sees it.
    // A taker without balance also reverts, so a failure only demotes the quote.
    simulate:
      process.env.GATEWAY_SIMULATE === 'false'
        ? undefined
        : async (req, quote) => {
            if (!quote.transaction) return 'skipped'
            try {
              await publicClientFor(req.chainId).call({ account: req.taker as Address, to: quote.transaction.to as Address, data: quote.transaction.data as Hex, value: quote.transaction.value })
              return 'ok'
            } catch {
              return 'failed'
            }
          },
  })
}

export const gateway = buildGateway()
