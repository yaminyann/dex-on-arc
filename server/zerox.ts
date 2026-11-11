/**
 * 0x Swap API client (server side only: the API key never reaches the browser).
 * Uses the AllowanceHolder endpoints. 0x supports Arc mainnet (5042) only;
 * Arc Testnet (5042002) is not a supported 0x chain.
 */

const ZEROEX_BASE = 'https://api.0x.org'

/** Chains 0x lists as supported and that this project allows. */
export const ZEROEX_SUPPORTED_CHAINS: ReadonlySet<number> = new Set([5042])

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const UINT_RE = /^[0-9]{1,78}$/

export type QuoteKind = 'quote' | 'price'

export interface QuoteRequest {
  chainId: number
  sellToken: string
  buyToken: string
  sellAmount: string
  taker: string
  slippageBps: number
}

export interface ApiError {
  status: number
  code: string
  message: string
}

export function zeroExConfigured(): boolean {
  return Boolean(process.env.ZEROEX_API_KEY)
}

/** Validates untrusted query parameters. Returns a request or a structured error. */
export function parseQuoteRequest(params: URLSearchParams): QuoteRequest | ApiError {
  const chainId = Number(params.get('chainId'))
  const sellToken = params.get('sellToken') ?? ''
  const buyToken = params.get('buyToken') ?? ''
  const sellAmount = params.get('sellAmount') ?? ''
  const taker = params.get('taker') ?? ''
  const slippageBps = Number(params.get('slippageBps') ?? '50')

  if (!Number.isInteger(chainId)) return { status: 400, code: 'INPUT_INVALID', message: 'chainId must be an integer' }
  if (!ZEROEX_SUPPORTED_CHAINS.has(chainId)) {
    return {
      status: 400,
      code: 'CHAIN_NOT_SUPPORTED',
      message: `0x does not support chain ${chainId}. Supported on Arc: mainnet (5042) only.`,
    }
  }
  if (!ADDRESS_RE.test(sellToken) || !ADDRESS_RE.test(buyToken)) {
    return { status: 400, code: 'INPUT_INVALID', message: 'sellToken and buyToken must be token addresses' }
  }
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
    return { status: 400, code: 'INPUT_INVALID', message: 'sellToken and buyToken must differ' }
  }
  if (!UINT_RE.test(sellAmount) || BigInt(sellAmount) === 0n) {
    return { status: 400, code: 'INPUT_INVALID', message: 'sellAmount must be a positive integer in base units' }
  }
  if (!ADDRESS_RE.test(taker)) return { status: 400, code: 'INPUT_INVALID', message: 'taker must be an address' }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000) {
    return { status: 400, code: 'INPUT_INVALID', message: 'slippageBps must be an integer from 0 to 1000' }
  }
  return { chainId, sellToken, buyToken, sellAmount, taker, slippageBps }
}

export function isApiError(value: QuoteRequest | ApiError): value is ApiError {
  return 'code' in value
}

interface ZeroExFill {
  from: string
  to: string
  source: string
  proportionBps: string
}

interface ZeroExResponse {
  liquidityAvailable?: boolean
  buyAmount?: string
  minBuyAmount?: string
  sellAmount?: string
  buyToken?: string
  sellToken?: string
  route?: { fills?: ZeroExFill[] }
  fees?: unknown
  issues?: {
    allowance?: { actual: string; spender: string } | null
    balance?: { token: string; actual: string; expected: string } | null
    simulationIncomplete?: boolean
  }
  totalNetworkFee?: string | null
  transaction?: { to: string; data: string; gas?: string | null; gasPrice?: string; value: string }
  zid?: string
  name?: string
  message?: string
}

/** Fetches an indicative price or a firm quote and returns only the fields the app uses. */
export async function fetchZeroEx(kind: QuoteKind, req: QuoteRequest): Promise<{ status: number; body: unknown }> {
  const key = process.env.ZEROEX_API_KEY
  if (!key) {
    return {
      status: 503,
      body: { error: { code: 'ZEROEX_NOT_CONFIGURED', message: 'ZEROEX_API_KEY is not set on the server.' } },
    }
  }
  const url = new URL(`${ZEROEX_BASE}/swap/allowance-holder/${kind}`)
  url.searchParams.set('chainId', String(req.chainId))
  url.searchParams.set('sellToken', req.sellToken)
  url.searchParams.set('buyToken', req.buyToken)
  url.searchParams.set('sellAmount', req.sellAmount)
  url.searchParams.set('taker', req.taker)
  url.searchParams.set('slippageBps', String(req.slippageBps))

  const res = await fetch(url, { headers: { '0x-api-key': key, '0x-version': 'v2' } })
  const json = (await res.json().catch(() => ({}))) as ZeroExResponse

  if (!res.ok) {
    return {
      status: res.status,
      body: { error: { code: json.name ?? 'UPSTREAM_ERROR', message: json.message ?? `0x responded with ${res.status}` } },
    }
  }
  if (json.liquidityAvailable === false) {
    return { status: 200, body: { liquidityAvailable: false, zid: json.zid } }
  }
  return {
    status: 200,
    body: {
      liquidityAvailable: true,
      sellToken: json.sellToken,
      buyToken: json.buyToken,
      sellAmount: json.sellAmount,
      buyAmount: json.buyAmount,
      minBuyAmount: json.minBuyAmount,
      route: json.route?.fills ?? [],
      fees: json.fees,
      issues: json.issues,
      totalNetworkFee: json.totalNetworkFee ?? null,
      transaction: kind === 'quote' ? json.transaction : undefined,
      zid: json.zid,
    },
  }
}
