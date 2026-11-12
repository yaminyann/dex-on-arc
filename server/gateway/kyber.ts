/**
 * KyberSwap Aggregator provider (keyless). API shape verified against the live Arc endpoint on 2026-11-12:
 *   GET  https://aggregator-api.kyberswap.com/arc/api/v1/routes?tokenIn&tokenOut&amountIn
 *   POST https://aggregator-api.kyberswap.com/arc/api/v1/route/build  { routeSummary, sender, recipient, slippageTolerance }
 * Tokens are approved to the router (not to a separate allowance contract), and calldata is built for
 * `sender`/`recipient`, so keepers pass the orders contract as taker and the output lands in the contract.
 */
import { feeAmount } from './fee'
import type { GatewayQuote, GatewayRequest, ProviderResult, QuoteKind, QuoteProvider, RouteFill } from './types'

const BASE = 'https://aggregator-api.kyberswap.com'
const CHAIN_SLUGS: Readonly<Record<number, string>> = { 5042: 'arc' }
/** KyberSwap MetaAggregationRouterV2. Code is present at this address on Arc mainnet. Override with KYBER_ROUTER_ALLOWLIST. */
export const KYBER_ROUTER_DEFAULT = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
const ROUTE_NOT_FOUND = 4008

interface KyberEnvelope<T> {
  code?: number
  message?: string
  data?: T
}

interface RouteSummary {
  amountIn: string
  amountOut: string
  gas?: string
  gasPrice?: string
  route?: { pool?: string; tokenIn: string; tokenOut: string; swapAmount: string; exchange?: string }[][]
  [k: string]: unknown
}

interface RouteData {
  routeSummary: RouteSummary
  routerAddress: string
}

interface BuildData {
  amountOut: string
  gas?: string
  data: string
  routerAddress: string
  transactionValue?: string
}

export type AllowanceReader = (chainId: number, token: string, owner: string, spender: string) => Promise<bigint | null>
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface KyberOptions {
  clientId?: string
  routers?: readonly string[]
  readAllowance?: AllowanceReader
  fetchFn?: Fetch
}

function err(status: number, code: string, message: string, retryable = false): ProviderResult {
  return { kind: 'error', status, code, message, retryable }
}

/** Fills from a Kyber route summary, grouped per pool hop and expressed in the app's route shape. */
export function kyberRoute(summary: RouteSummary): RouteFill[] {
  const total = BigInt(summary.amountIn || '0')
  const fills: RouteFill[] = []
  for (const path of summary.route ?? []) {
    for (const hop of path) {
      const share = total > 0n ? (BigInt(hop.swapAmount || '0') * 10_000n) / total : 0n
      fills.push({ from: hop.tokenIn, to: hop.tokenOut, source: hop.exchange ?? 'kyberswap', proportionBps: share.toString() })
    }
  }
  return fills
}

/** Guaranteed minimum output for a slippage tolerance in bps, rounded down like the router. */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n
}

export function createKyberProvider(opts: KyberOptions = {}): QuoteProvider {
  const clientId = opts.clientId ?? process.env.KYBER_CLIENT_ID ?? 'arc-terminal'
  const routers = (opts.routers ?? (process.env.KYBER_ROUTER_ALLOWLIST ? process.env.KYBER_ROUTER_ALLOWLIST.split(',') : [KYBER_ROUTER_DEFAULT])).map((r) => r.trim().toLowerCase())
  const doFetch: Fetch = opts.fetchFn ?? ((input, init) => fetch(input, init))

  async function call<T>(path: string, init: RequestInit): Promise<{ status: number; json: KyberEnvelope<T> }> {
    const res = await doFetch(`${BASE}${path}`, { ...init, headers: { 'x-client-id': clientId, accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } })
    const json = (await res.json().catch(() => ({}))) as KyberEnvelope<T>
    return { status: res.status, json }
  }

  return {
    id: 'kyber',
    configured: () => true,
    supports: (chainId) => chainId in CHAIN_SLUGS,
    async fetch(kind: QuoteKind, req: GatewayRequest, signal: AbortSignal): Promise<ProviderResult> {
      const slug = CHAIN_SLUGS[req.chainId]
      if (!slug) return err(400, 'CHAIN_NOT_SUPPORTED', `KyberSwap does not support chain ${req.chainId}.`)
      const qs = new URLSearchParams({ tokenIn: req.sellToken, tokenOut: req.buyToken, amountIn: req.sellAmount, gasInclude: 'true' })
      // The fee is taken from the sell amount by the router and paid to the recipient in the same transaction.
      if (req.fee) {
        qs.set('feeAmount', String(req.fee.bps))
        qs.set('chargeFeeBy', 'currency_in')
        qs.set('isInBps', 'true')
        qs.set('feeReceiver', req.fee.recipient)
      }
      const route = await call<RouteData>(`/${slug}/api/v1/routes?${qs}`, { signal })
      if (route.json.code === ROUTE_NOT_FOUND) return { kind: 'no_liquidity' }
      if (route.status !== 200 || route.json.code !== 0 || !route.json.data?.routeSummary) {
        return err(route.status === 200 ? 502 : route.status, `KYBER_${route.json.code ?? 'ERROR'}`, route.json.message ?? 'KyberSwap route request failed.', route.status === 429 || route.status >= 500)
      }
      const { routeSummary, routerAddress } = route.json.data
      if (!routers.includes(routerAddress.toLowerCase())) {
        return err(502, 'UNTRUSTED_ROUTER', `KyberSwap returned an unexpected router ${routerAddress}; refusing it.`)
      }
      if (BigInt(routeSummary.amountIn) !== BigInt(req.sellAmount)) {
        return err(502, 'AMOUNT_MISMATCH', 'KyberSwap quoted a different sell amount than requested.')
      }

      let amountOut = BigInt(routeSummary.amountOut)
      let gasUnits = routeSummary.gas ? BigInt(routeSummary.gas) : null
      let transaction: GatewayQuote['transaction']
      if (kind === 'quote') {
        const build = await call<BuildData>(`/${slug}/api/v1/route/build`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ routeSummary, sender: req.taker, recipient: req.taker, slippageTolerance: req.slippageBps }),
          signal,
        })
        if (build.status !== 200 || build.json.code !== 0 || !build.json.data?.data) {
          return err(build.status === 200 ? 502 : build.status, `KYBER_${build.json.code ?? 'ERROR'}`, build.json.message ?? 'KyberSwap build request failed.', build.status === 429 || build.status >= 500)
        }
        const b = build.json.data
        if (!routers.includes(b.routerAddress.toLowerCase())) {
          return err(502, 'UNTRUSTED_ROUTER', `KyberSwap returned an unexpected router ${b.routerAddress}; refusing it.`)
        }
        amountOut = BigInt(b.amountOut)
        gasUnits = b.gas ? BigInt(b.gas) : gasUnits
        transaction = { to: b.routerAddress, data: b.data, value: BigInt(b.transactionValue ?? '0'), gas: gasUnits }
      }

      let allowance: GatewayQuote['allowance'] = null
      if (opts.readAllowance) {
        const actual = await opts.readAllowance(req.chainId, req.sellToken, req.taker, routerAddress).catch(() => null)
        if (actual !== null && actual < BigInt(req.sellAmount)) allowance = { spender: routerAddress, actual }
        // An unreadable allowance is reported as insufficient so the UI asks for an exact approval
        // instead of sending a swap that would revert.
        if (actual === null) allowance = { spender: routerAddress, actual: 0n }
      }

      const gasPrice = routeSummary.gasPrice ? BigInt(routeSummary.gasPrice) : null
      return {
        kind: 'quote',
        quote: {
          provider: 'kyber',
          sellAmount: BigInt(req.sellAmount),
          buyAmount: amountOut,
          minBuyAmount: minOut(amountOut, req.slippageBps),
          route: kyberRoute(routeSummary),
          networkFeeNative: gasUnits !== null && gasPrice !== null ? gasUnits * gasPrice : null,
          allowance,
          spender: routerAddress,
          platformFee: req.fee ? { bps: req.fee.bps, recipient: req.fee.recipient, amount: feeAmount(BigInt(req.sellAmount), req.fee.bps) } : undefined,
          transaction,
        },
      }
    },
  }
}
