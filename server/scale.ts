/**
 * Small, dependency-free building blocks used to keep the backend cheap under load:
 * a TTL cache with request coalescing, a fixed-window rate limiter, keeper sharding,
 * per-item exponential backoff, and batching helpers.
 */

/** Caches successful loads for `ttlMs` and shares one in-flight load between concurrent callers. */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expires: number }>()
  private inflight = new Map<string, Promise<T>>()

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
  ) {}

  async get(key: string, loader: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && hit.expires > now) return hit.value
    const pending = this.inflight.get(key)
    if (pending) return pending
    const p = loader()
      .then((value) => {
        this.entries.set(key, { value, expires: Date.now() + this.ttlMs })
        this.evict()
        return value
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  get size(): number {
    return this.entries.size
  }

  private evict() {
    if (this.entries.size <= this.maxEntries) return
    const now = Date.now()
    for (const [k, v] of this.entries) if (v.expires <= now) this.entries.delete(k)
    // Still over the cap: drop the oldest insertions.
    while (this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next().value
      if (first === undefined) break
      this.entries.delete(first)
    }
  }
}

/** Fixed-window limiter: at most `limit` requests per `windowMs` per key. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>()

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key)
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 })
      this.sweep(now)
      return true
    }
    if (w.count >= this.limit) return false
    w.count += 1
    return true
  }

  /** Seconds until the key's window resets (for Retry-After). */
  retryAfter(key: string, now = Date.now()): number {
    const w = this.windows.get(key)
    return w ? Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)) : 1
  }

  private sweep(now: number) {
    if (this.windows.size < 5000) return
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k)
    // Hard cap so a flood of distinct keys cannot grow memory without bound.
    while (this.windows.size > 50_000) {
      const oldest = this.windows.keys().next().value
      if (oldest === undefined) break
      this.windows.delete(oldest)
    }
  }
}

/** Deterministic split of work across keeper instances: each id belongs to exactly one shard. */
export function inShard(id: bigint, shardIndex: number, shardCount: number): boolean {
  if (shardCount <= 1) return true
  return Number(id % BigInt(shardCount)) === shardIndex
}

/** Exponential backoff per key. A key is skipped until its `until` time passes. */
export class Backoff {
  private state = new Map<string, { fails: number; until: number }>()

  constructor(
    private baseMs = 30_000,
    private maxMs = 10 * 60_000,
  ) {}

  ready(key: string, now = Date.now()): boolean {
    const s = this.state.get(key)
    return !s || s.until <= now
  }

  fail(key: string, now = Date.now()): number {
    const fails = (this.state.get(key)?.fails ?? 0) + 1
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** (fails - 1))
    this.state.set(key, { fails, until: now + delay })
    return delay
  }

  clear(key: string) {
    this.state.delete(key)
  }

  get size(): number {
    return this.state.size
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/** Rolling counters exposed on /metrics. */
export const metrics = {
  startedAt: Date.now(),
  http: { requests: 0, rateLimited: 0, cacheHits: 0, cacheMisses: 0, upstreamErrors: 0 },
  keeper: {
    ticks: 0,
    lastTickMs: 0,
    openOrders: 0,
    openDcas: 0,
    rpcMulticalls: 0,
    executed: 0,
    failedExecutions: 0,
    skippedBackoff: 0,
    maintenanceCalls: 0,
    skippedUnprofitable: 0,
    standbyWaiting: 0,
    txSent: 0,
    wakeups: 0,
    batches: 0,
    txFailed: 0,
    consecutiveTickErrors: 0,
    /** Keeper wallet balance in whole USDC, or -1 until first read. */
    balanceUsdc: -1,
    /** Unix ms of the last tick that finished without throwing, 0 if none yet. */
    lastOkTickAt: 0,
  },
}
