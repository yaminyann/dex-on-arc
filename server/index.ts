/**
 * Backend for the trading terminal.
 *  - GET /health   provider status. Public view is redacted; operators (see ADMIN_TOKEN) get full detail
 *  - GET /metrics  counters for operators only
 *  - GET /price    indicative 0x price (no transaction data), cached briefly and coalesced
 *  - GET /quote    firm 0x quote including the transaction to sign (never cached)
 * Run with `bun run server`. The Vite dev server proxies /api to this process.
 *
 * Trust and abuse controls (env, all optional):
 *   TRUSTED_PROXY_HOPS  number of reverse proxies in front of this process. 0 (default) ignores
 *                       x-forwarded-for entirely, so clients cannot choose their own rate-limit bucket
 *   ALLOWED_ORIGINS     comma-separated browser origins allowed to call /price and /quote
 *   ADMIN_TOKEN         bearer token for /metrics and detailed /health. Unset: loopback-only, direct
 *   UPSTREAM_BUDGET_PER_MIN  global cap on calls to 0x from this process (default 600)
 */
import { fetchZeroEx, isApiError, parseQuoteRequest, zeroExConfigured, ZEROEX_SUPPORTED_CHAINS } from './zerox'
import { keeperStatus, startKeeper } from './keeper'
import { listProviders } from './automation/providers'
import { metrics, RateLimiter, TtlCache } from './scale'
import { isOperator, originAllowed, parseList, resolveClientIp } from './security'

const port = Number(process.env.API_PORT ?? 3001)
const PRICE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS ?? 4000)
const trustedHops = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS ?? 0)) || 0)
const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS)
const adminToken = process.env.ADMIN_TOKEN || undefined

// Per-client limits per minute. Tune with RATE_LIMIT_SCALE (e.g. 2 doubles every limit).
const scale = Math.max(0.1, Number(process.env.RATE_LIMIT_SCALE ?? 1))
const limits = {
  price: new RateLimiter(Math.round(90 * scale), 60_000),
  quote: new RateLimiter(Math.round(20 * scale), 60_000),
  other: new RateLimiter(Math.round(240 * scale), 60_000),
}

// Whatever the callers do, this process never sends 0x more than this many requests per minute,
// so the API key cannot be drained by many clients at once.
const upstreamBudget = new RateLimiter(Math.max(1, Math.floor(Number(process.env.UPSTREAM_BUDGET_PER_MIN ?? 600)) || 600), 60_000)

const priceCache = new TtlCache<{ status: number; body: unknown }>(PRICE_TTL_MS, 1000)

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  })
}

function budgetExceeded() {
  return {
    status: 503,
    body: { error: { code: 'UPSTREAM_BUDGET_EXCEEDED', message: 'The quote service is busy. Retry in a moment.' } },
  }
}

const server = Bun.serve({
  port,
  async fetch(req, srv) {
    metrics.http.requests += 1
    const url = new URL(req.url)
    if (req.method !== 'GET') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } }, 405)

    const socketIp = srv.requestIP(req)?.address
    const bucket = url.pathname === '/price' ? 'price' : url.pathname === '/quote' ? 'quote' : 'other'
    const key = resolveClientIp(req.headers.get('x-forwarded-for'), socketIp, trustedHops)
    if (!limits[bucket].allow(key)) {
      metrics.http.rateLimited += 1
      return json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and retry.' } }, 429, {
        'retry-after': String(limits[bucket].retryAfter(key)),
      })
    }

    const operator = isOperator(req.headers, socketIp, adminToken)

    if (url.pathname === '/health') {
      const keeper = keeperStatus()
      // The public view hides the keeper address and raw errors (an error string can embed an RPC URL).
      const view = operator
        ? keeper
        : { ...keeper, keeperAddress: null, lastError: keeper.lastError ? 'Keeper reported an error. Details are restricted to operators.' : null }
      return json({
        ok: true,
        zeroEx: { configured: zeroExConfigured(), chains: [...ZEROEX_SUPPORTED_CHAINS] },
        keeper: view,
        automationProviders: listProviders(),
      })
    }

    if (url.pathname === '/metrics') {
      if (!operator) return json({ error: { code: 'FORBIDDEN', message: 'Operator access required.' } }, 403)
      return json({
        uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
        http: { ...metrics.http, priceCacheEntries: priceCache.size },
        keeper: metrics.keeper,
      })
    }

    if (url.pathname === '/price' || url.pathname === '/quote') {
      if (!originAllowed(req.headers.get('origin'), req.headers.get('referer'), allowedOrigins)) {
        return json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This origin may not use the quote service.' } }, 403)
      }
      const parsed = parseQuoteRequest(url.searchParams)
      if (isApiError(parsed)) return json({ error: { code: parsed.code, message: parsed.message } }, parsed.status)
      try {
        if (url.pathname === '/price') {
          // Identical requests inside the TTL share one upstream call.
          const cacheKey = [parsed.chainId, parsed.sellToken, parsed.buyToken, parsed.sellAmount, parsed.taker, parsed.slippageBps].join(':').toLowerCase()
          let fresh = false
          const out = await priceCache.get(cacheKey, async () => {
            fresh = true
            if (!upstreamBudget.allow('global')) return budgetExceeded()
            return fetchZeroEx('price', parsed)
          })
          if (fresh) metrics.http.cacheMisses += 1
          else metrics.http.cacheHits += 1
          return json(out.body, out.status, { 'x-cache': fresh ? 'miss' : 'hit' })
        }
        if (!upstreamBudget.allow('global')) {
          const out = budgetExceeded()
          return json(out.body, out.status, { 'retry-after': String(upstreamBudget.retryAfter('global')) })
        }
        const out = await fetchZeroEx('quote', parsed)
        return json(out.body, out.status)
      } catch {
        metrics.http.upstreamErrors += 1
        return json({ error: { code: 'UPSTREAM_UNREACHABLE', message: 'Could not reach the 0x API.' } }, 502)
      }
    }

    return json({ error: { code: 'NOT_FOUND', message: 'Unknown route' } }, 404)
  },
})

console.log(
  `[api] listening on :${server.port} (0x key ${zeroExConfigured() ? 'configured' : 'missing'}, trusted proxy hops ${trustedHops}, ` +
    `origin gate ${allowedOrigins.length ? 'on' : 'off'}, operator auth ${adminToken ? 'token' : 'loopback only'})`,
)
if (!adminToken) console.warn('[api] ADMIN_TOKEN is not set: /metrics and detailed /health are limited to direct loopback requests. Set it in production.')
startKeeper()
