/**
 * Load test for the quote gateway. Many simulated wallets ask for prices on a small set of pairs, the
 * way a busy terminal does, so the numbers show how well the shared price cache and request coalescing
 * absorb the load.
 *
 *   bun run scripts/load-test.ts --url http://localhost:3001 --chain 5042002 --requests 600 --wallets 60 --concurrency 30
 *
 * Start the backend with RATE_LIMIT_SCALE=100 (or higher) so the per-client limiter does not hide the
 * results: every simulated wallet comes from one IP. Reads only; it sends no transactions.
 */
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1] ?? '')

const url = args.get('url') ?? 'http://localhost:3001'
const chain = Number(args.get('chain') ?? 5042002)
const total = Number(args.get('requests') ?? 400)
const wallets = Number(args.get('wallets') ?? 40)
const concurrency = Number(args.get('concurrency') ?? 25)

const USDC = '0x3600000000000000000000000000000000000000'
const PAIRS: Record<number, { buy: string; amounts: string[] }[]> = {
  5042002: [
    { buy: '0x661bf226688f011115a84f5a1243ca6b467c8dfe', amounts: ['1000000', '5000000'] },
    { buy: '0x4e15db0f6872c3c54df4ebf87528b582746e020b', amounts: ['1000000', '5000000'] },
  ],
  5042: [{ buy: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', amounts: ['1000000', '10000000'] }],
}
const pairs = PAIRS[chain]
if (!pairs) throw new Error(`No load-test pairs for chain ${chain}`)

const walletAddr = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`

interface Sample {
  ms: number
  status: number
  cache: string | null
  provider?: string
}

async function one(i: number): Promise<Sample> {
  const pair = pairs[i % pairs.length]
  const amount = pair.amounts[(i >> 1) % pair.amounts.length]
  const qs = new URLSearchParams({ chainId: String(chain), sellToken: USDC, buyToken: pair.buy, sellAmount: amount, taker: walletAddr(i % wallets), slippageBps: '50' })
  const started = performance.now()
  try {
    const res = await fetch(`${url}/price?${qs}`)
    const body = (await res.json().catch(() => ({}))) as { provider?: string }
    return { ms: performance.now() - started, status: res.status, cache: res.headers.get('x-cache'), provider: body.provider }
  } catch {
    return { ms: performance.now() - started, status: 0, cache: null }
  }
}

const samples: Sample[] = []
let next = 0
const started = performance.now()
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (;;) {
      const i = next++
      if (i >= total) return
      samples.push(await one(i))
    }
  }),
)
const elapsed = (performance.now() - started) / 1000

const pct = (p: number) => {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
const count = (f: (s: Sample) => boolean) => samples.filter(f).length
const ok = count((s) => s.status === 200)
const hits = count((s) => s.cache === 'hit')
const misses = count((s) => s.cache === 'miss')

console.log(JSON.stringify(
  {
    target: url,
    chain,
    requests: samples.length,
    wallets,
    concurrency,
    seconds: Number(elapsed.toFixed(2)),
    requestsPerSecond: Number((samples.length / elapsed).toFixed(1)),
    ok,
    rateLimited: count((s) => s.status === 429),
    errors: count((s) => s.status !== 200 && s.status !== 429),
    cacheHitRatio: hits + misses > 0 ? Number((hits / (hits + misses)).toFixed(3)) : null,
    upstreamLookups: misses,
    latencyMs: { p50: Math.round(pct(50)), p95: Math.round(pct(95)), p99: Math.round(pct(99)), max: Math.round(Math.max(...samples.map((s) => s.ms))) },
    providers: Object.fromEntries([...new Set(samples.map((s) => s.provider ?? 'none'))].map((p) => [p, count((s) => (s.provider ?? 'none') === p)])),
  },
  null,
  2,
))
