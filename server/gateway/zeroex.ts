import { feeAmount } from './fee'
import { fetchZeroEx, zeroExConfigured, ZEROEX_SUPPORTED_CHAINS } from '../zerox'
import type { GatewayQuote, GatewayRequest, ProviderResult, QuoteKind, QuoteProvider, RouteFill } from './types'

interface ZeroExBody {
  liquidityAvailable?: boolean
  buyAmount?: string
  minBuyAmount?: string
  sellAmount?: string
  route?: RouteFill[]
  totalNetworkFee?: string | null
  issues?: { allowance?: { actual: string; spender: string } | null }
  transaction?: { to: string; data: string; value?: string; gas?: string | null }
  error?: { code: string; message: string }
}

/** Maps the already-validated 0x client output (server/zerox.ts) onto the gateway's quote shape. */
export function normalizeZeroEx(status: number, body: unknown): ProviderResult {
  const b = (body ?? {}) as ZeroExBody
  if (b.error) {
    return { kind: 'error', status, code: b.error.code, message: b.error.message, retryable: status === 429 || status >= 500 }
  }
  if (!b.liquidityAvailable) return { kind: 'no_liquidity' }
  if (!b.buyAmount || !b.minBuyAmount || !b.sellAmount) {
    return { kind: 'error', status: 502, code: 'MALFORMED_RESPONSE', message: '0x returned an incomplete quote.', retryable: true }
  }
  const quote: GatewayQuote = {
    provider: '0x',
    sellAmount: BigInt(b.sellAmount),
    buyAmount: BigInt(b.buyAmount),
    minBuyAmount: BigInt(b.minBuyAmount),
    route: b.route ?? [],
    networkFeeNative: b.totalNetworkFee ? BigInt(b.totalNetworkFee) : null,
    allowance: b.issues?.allowance ? { spender: b.issues.allowance.spender, actual: BigInt(b.issues.allowance.actual) } : null,
    spender: b.issues?.allowance?.spender ?? null,
    transaction: b.transaction
      ? { to: b.transaction.to, data: b.transaction.data, value: BigInt(b.transaction.value ?? '0'), gas: b.transaction.gas ? BigInt(b.transaction.gas) : null }
      : undefined,
  }
  return { kind: 'quote', quote }
}

export const zeroExProvider: QuoteProvider = {
  id: '0x',
  configured: zeroExConfigured,
  supports: (chainId) => ZEROEX_SUPPORTED_CHAINS.has(chainId),
  async fetch(kind: QuoteKind, req: GatewayRequest, signal: AbortSignal): Promise<ProviderResult> {
    const out = await fetchZeroEx(kind, { ...req, chainId: req.chainId }, signal)
    const res = normalizeZeroEx(out.status, out.body)
    if (res.kind === 'quote' && req.fee) res.quote.platformFee = { bps: req.fee.bps, recipient: req.fee.recipient, amount: feeAmount(res.quote.sellAmount, req.fee.bps) }
    return res
  },
}
