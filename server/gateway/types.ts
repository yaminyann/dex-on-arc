/** Shared shapes for the multi-aggregator quote gateway. */

export interface GatewayRequest {
  chainId: number
  sellToken: string
  buyToken: string
  /** Base units, decimal string. */
  sellAmount: string
  /** Address that holds the sell token and receives the output (the user, or the orders contract for keepers). */
  taker: string
  slippageBps: number
}

export interface RouteFill {
  from: string
  to: string
  source: string
  proportionBps: string
}

export interface GatewayQuote {
  provider: string
  sellAmount: bigint
  buyAmount: bigint
  minBuyAmount: bigint
  route: RouteFill[]
  /** Network fee in the 18-decimal native (USDC) view, when the provider reports gas. */
  networkFeeNative: bigint | null
  /** Set only when the taker's allowance for `spender` is below the sell amount. */
  allowance: { spender: string; actual: bigint } | null
  /** Present for firm quotes only. */
  transaction?: { to: string; data: string; value: bigint; gas: bigint | null }
  /** Result of an eth_call of the transaction from the taker. Demotes failing quotes in ranking. */
  simulation?: 'ok' | 'failed' | 'skipped'
}

export type ProviderResult =
  | { kind: 'quote'; quote: GatewayQuote }
  | { kind: 'no_liquidity' }
  | { kind: 'error'; status: number; code: string; message: string; retryable: boolean }

export type QuoteKind = 'price' | 'quote'

export interface QuoteProvider {
  id: string
  /** False when the provider needs credentials that are not set. Unconfigured providers are skipped. */
  configured(): boolean
  supports(chainId: number): boolean
  fetch(kind: QuoteKind, req: GatewayRequest, signal: AbortSignal): Promise<ProviderResult>
}

export type Outcome = 'quote' | 'no_liquidity' | 'error' | 'timeout' | 'breaker_open' | 'budget' | 'unconfigured' | 'unsupported'

export interface ProviderOutcome {
  provider: string
  outcome: Outcome
  ms: number
  code?: string
}
