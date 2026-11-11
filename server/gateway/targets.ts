/**
 * Swap contracts the backend recognises per chain. Used to decide which transactions count as market
 * swaps when verifying reports. The browser keeps its own copy in src/trading/networks.ts and pins
 * what it will sign against that; keep the two in step.
 */
import harness from '../../src/trading/testnet-harness.json'
import { KYBER_ROUTER_DEFAULT } from './kyber'

export const ZEROEX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734'

export function swapTargetsFor(chainId: number, env: Record<string, string | undefined> = process.env): string[] {
  if (chainId === 5042) {
    const kyber = (env.KYBER_ROUTER_ALLOWLIST ? env.KYBER_ROUTER_ALLOWLIST.split(',') : [KYBER_ROUTER_DEFAULT]).map((s) => s.trim()).filter(Boolean)
    return [ZEROEX_ALLOWANCE_HOLDER, ...kyber]
  }
  if (chainId === 5042002) {
    const h = harness as { router?: string; routerB?: string }
    return [h.router, h.routerB].filter((a): a is string => Boolean(a))
  }
  return []
}
