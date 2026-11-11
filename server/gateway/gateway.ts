/**
 * Quote gateway: asks every configured aggregator in parallel, ranks the answers by guaranteed
 * output net of gas, and degrades gracefully. A provider that keeps failing is skipped for a
 * cooldown (circuit breaker); a slow one is cut off by a timeout; each provider has its own
 * request budget so one noisy caller cannot burn a paid API key.
 */
import { RateLimiter } from '../scale'
import type { GatewayQuote, GatewayRequest, Outcome, ProviderOutcome, QuoteKind, QuoteProvider } from './types'

export interface GatewayOptions {
  timeoutMs?: number
  /** Consecutive failures that open a provider's breaker. */
  breakerThreshold?: number
  breakerCooldownMs?: number
  /** Upstream requests per provider per minute. */
  budgetPerMin?: number
  /** USDC on the chain, used to subtract gas when the buy token is USDC. */
  usdc?: Readonly<Record<number, string>>
  /** Optional eth_call check of firm quotes. Failing quotes are demoted, never trusted. */
  simulate?: (req: GatewayRequest, quote: GatewayQuote) => Promise<'ok' | 'failed' | 'skipped'>
  now?: () => number
}

interface Breaker {
  fails: number
  openUntil: number
}

export interface GatewayResult {
  ranked: GatewayQuote[]
  outcomes: ProviderOutcome[]
  /** First provider error, kept so callers can surface a real reason when nothing answered. */
  firstError?: { status: number; code: string; message: string }
}

export interface WireResponse {
  status: number
  body: unknown
}

const NATIVE_PER_USDC_UNIT = 10n ** 12n

export class Gateway {
  private breakers = new Map<string, Breaker>()
  private budgets = new Map<string, RateLimiter>()
  private opts: Required<Pick<GatewayOptions, 'timeoutMs' | 'breakerThreshold' | 'breakerCooldownMs' | 'budgetPerMin'>> & GatewayOptions

  constructor(
    readonly providers: readonly QuoteProvider[],
    opts: GatewayOptions = {},
  ) {
    this.opts = { timeoutMs: 4000, breakerThreshold: 3, breakerCooldownMs: 30_000, budgetPerMin: 600, ...opts }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /** Operator view of each provider for /health and metrics. */
  status() {
    const now = this.now()
    return this.providers.map((p) => {
      const b = this.breakers.get(p.id)
      return { id: p.id, configured: p.configured(), breaker: b && b.openUntil > now ? 'open' : 'closed', consecutiveFailures: b?.fails ?? 0 }
    })
  }

  get configured(): boolean {
    return this.providers.some((p) => p.configured())
  }

  private breakerOpen(id: string): boolean {
    const b = this.breakers.get(id)
    return Boolean(b && b.openUntil > this.now())
  }

  private recordSuccess(id: string) {
    this.breakers.delete(id)
  }

  private recordFailure(id: string) {
    const b = this.breakers.get(id) ?? { fails: 0, openUntil: 0 }
    b.fails += 1
    // After the cooldown the next request is a half-open probe: one more failure re-opens immediately.
    if (b.fails >= this.opts.breakerThreshold) b.openUntil = this.now() + this.opts.breakerCooldownMs
    this.breakers.set(id, b)
  }

  private budget(id: string): RateLimiter {
    let r = this.budgets.get(id)
    if (!r) {
      r = new RateLimiter(this.opts.budgetPerMin, 60_000)
      this.budgets.set(id, r)
    }
    return r
  }

  /** Score used for ranking: guaranteed output, minus gas when both are denominated in USDC. */
  score(req: GatewayRequest, q: GatewayQuote): bigint {
    const usdc = this.opts.usdc?.[req.chainId]?.toLowerCase()
    let s = q.minBuyAmount
    if (usdc && req.buyToken.toLowerCase() === usdc && q.networkFeeNative !== null) s -= q.networkFeeNative / NATIVE_PER_USDC_UNIT
    return s
  }

  /**
   * `simulate: false` skips the eth_call check. Keepers use it because their taker is the orders contract,
   * which only holds an approval inside `execute`, so a standalone call would always look like a failure.
   */
  async rank(kind: QuoteKind, req: GatewayRequest, opts: { simulate?: boolean } = {}): Promise<GatewayResult> {
    const outcomes: ProviderOutcome[] = []
    const quotes: GatewayQuote[] = []
    let firstError: GatewayResult['firstError']

    await Promise.all(
      this.providers.map(async (p) => {
        const started = this.now()
        const done = (outcome: Outcome, code?: string) => outcomes.push({ provider: p.id, outcome, ms: this.now() - started, code })
        if (!p.configured()) return done('unconfigured')
        if (!p.supports(req.chainId)) return done('unsupported')
        if (this.breakerOpen(p.id)) return done('breaker_open')
        if (!this.budget(p.id).allow('all')) return done('budget')

        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs)
        try {
          // The signal cancels the provider's HTTP calls; the race also bounds work that ignores it
          // (for example an RPC read), so no provider can hold the response past the timeout.
          const res = await Promise.race([
            p.fetch(kind, req, ctrl.signal),
            new Promise<never>((_resolve, reject) => ctrl.signal.addEventListener('abort', () => reject(new Error('timeout')))),
          ])
          if (res.kind === 'quote') {
            this.recordSuccess(p.id)
            quotes.push(res.quote)
            done('quote')
          } else if (res.kind === 'no_liquidity') {
            // The provider answered correctly; this is not a health problem.
            this.recordSuccess(p.id)
            done('no_liquidity')
          } else {
            if (res.retryable) this.recordFailure(p.id)
            firstError ??= { status: res.status, code: res.code, message: res.message }
            done('error', res.code)
          }
        } catch {
          this.recordFailure(p.id)
          const timedOut = ctrl.signal.aborted
          firstError ??= { status: 504, code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE', message: `${p.id} did not answer.` }
          done(timedOut ? 'timeout' : 'error', timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE')
        } finally {
          clearTimeout(timer)
        }
      }),
    )

    // Only firm quotes carry calldata worth checking.
    if (kind === 'quote' && this.opts.simulate && opts.simulate !== false) {
      await Promise.all(
        quotes.map(async (q) => {
          if (!q.transaction || q.allowance) return void (q.simulation = 'skipped')
          q.simulation = await this.opts.simulate!(req, q).catch(() => 'skipped' as const)
        }),
      )
    }

    const failedSim = (q: GatewayQuote) => (q.simulation === 'failed' ? 1 : 0)
    const ranked = quotes.sort((a, b) => {
      if (failedSim(a) !== failedSim(b)) return failedSim(a) - failedSim(b)
      const sa = this.score(req, a)
      const sb = this.score(req, b)
      if (sa !== sb) return sa > sb ? -1 : 1
      return a.provider < b.provider ? -1 : 1
    })
    return { ranked, outcomes: outcomes.sort((a, b) => (a.provider < b.provider ? -1 : 1)), firstError }
  }

  /** Best answer in the wire format the frontend already understands, plus the alternatives considered. */
  async best(kind: QuoteKind, req: GatewayRequest): Promise<WireResponse> {
    if (!this.configured) {
      return { status: 503, body: { error: { code: 'NO_PROVIDER_CONFIGURED', message: 'No quote provider is configured on the server.' } } }
    }
    const { ranked, outcomes, firstError } = await this.rank(kind, req)
    const best = ranked[0]
    if (!best) {
      const answered = outcomes.some((o) => o.outcome === 'no_liquidity')
      if (answered || !firstError) return { status: 200, body: { liquidityAvailable: false, providers: outcomes } }
      return { status: firstError.status >= 400 ? firstError.status : 502, body: { error: { code: firstError.code, message: firstError.message } } }
    }
    return { status: 200, body: toWire(kind, req, best, ranked, outcomes) }
  }
}

export function toWire(kind: QuoteKind, req: GatewayRequest, best: GatewayQuote, ranked: readonly GatewayQuote[], outcomes: readonly ProviderOutcome[]) {
  return {
    liquidityAvailable: true,
    provider: best.provider,
    sellToken: req.sellToken,
    buyToken: req.buyToken,
    sellAmount: best.sellAmount.toString(),
    buyAmount: best.buyAmount.toString(),
    minBuyAmount: best.minBuyAmount.toString(),
    route: best.route,
    issues: { allowance: best.allowance ? { spender: best.allowance.spender, actual: best.allowance.actual.toString() } : null },
    totalNetworkFee: best.networkFeeNative === null ? null : best.networkFeeNative.toString(),
    simulation: best.simulation,
    transaction:
      kind === 'quote' && best.transaction
        ? { to: best.transaction.to, data: best.transaction.data, value: best.transaction.value.toString(), gas: best.transaction.gas === null ? null : best.transaction.gas.toString() }
        : undefined,
    alternatives: ranked.map((q) => ({ provider: q.provider, buyAmount: q.buyAmount.toString(), minBuyAmount: q.minBuyAmount.toString(), simulation: q.simulation })),
    providers: outcomes,
  }
}
