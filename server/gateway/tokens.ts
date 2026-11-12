/**
 * Token list for the swap picker, taken from KyberSwap's public token registry for Arc (keyless).
 * The list is untrusted input: only whitelisted tokens that are not flagged as honeypots or
 * fee-on-transfer are kept, every text field is sanitised, and logos must be https URLs. Being in this
 * list does not make a token safe to hold; it only means the aggregator can route it.
 */
export interface ListedToken {
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI?: string
}

interface RawToken {
  address?: unknown
  symbol?: unknown
  name?: unknown
  decimals?: unknown
  logoURI?: unknown
  marketCap?: unknown
  isWhitelisted?: unknown
  isHoneypot?: unknown
  isFOT?: unknown
}

const REGISTRY = 'https://ks-setting.kyberswap.com/api/v1/tokens'
const SUPPORTED_CHAINS: ReadonlySet<number> = new Set([5042])
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const PAGE_SIZE = 100
const MAX_PAGES = 5

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Strips control characters and caps the length. Symbols and names come from third parties. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max)
}

/** Keeps safe, usable tokens from one registry page and normalises them. Exported for tests. */
export function normalizeTokens(raw: unknown[]): ListedToken[] {
  const out: (ListedToken & { cap: number })[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const t = (item ?? {}) as RawToken
    if (typeof t.address !== 'string' || !ADDRESS_RE.test(t.address)) continue
    if (t.isWhitelisted !== true || t.isHoneypot === true || t.isFOT === true) continue
    if (typeof t.decimals !== 'number' || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) continue
    const symbol = cleanText(t.symbol, 16)
    if (!symbol) continue
    const address = t.address.toLowerCase()
    if (seen.has(address)) continue
    seen.add(address)
    const logo = typeof t.logoURI === 'string' && t.logoURI.startsWith('https://') && t.logoURI.length <= 300 ? t.logoURI : undefined
    out.push({ address, symbol, name: cleanText(t.name, 40) || symbol, decimals: t.decimals, logoURI: logo, cap: typeof t.marketCap === 'number' ? t.marketCap : 0 })
  }
  // Biggest first, so the useful tokens lead the picker.
  return out.sort((a, b) => b.cap - a.cap).map(({ cap: _cap, ...token }) => token)
}

export interface TokenListOptions {
  fetchFn?: Fetch
  ttlMs?: number
  now?: () => number
}

export function createTokenList(opts: TokenListOptions = {}) {
  const doFetch: Fetch = opts.fetchFn ?? ((input, init) => fetch(input, init))
  const ttl = opts.ttlMs ?? 10 * 60_000
  const now = opts.now ?? (() => Date.now())
  const cache = new Map<number, { at: number; tokens: ListedToken[] }>()
  const inflight = new Map<number, Promise<ListedToken[]>>()

  async function load(chainId: number): Promise<ListedToken[]> {
    const raw: unknown[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await doFetch(`${REGISTRY}?chainIds=${chainId}&page=${page}&pageSize=${PAGE_SIZE}&isWhitelisted=true`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`token registry answered ${res.status}`)
      const json = (await res.json()) as { data?: { tokens?: unknown[]; pagination?: { totalItems?: number } } }
      const tokens = json.data?.tokens ?? []
      raw.push(...tokens)
      const total = json.data?.pagination?.totalItems ?? raw.length
      if (tokens.length < PAGE_SIZE || raw.length >= total) break
    }
    return normalizeTokens(raw)
  }

  return {
    supports: (chainId: number) => SUPPORTED_CHAINS.has(chainId),
    /** Cached list. If the registry is down, the last good list is served instead of an error. */
    async get(chainId: number): Promise<ListedToken[]> {
      if (!SUPPORTED_CHAINS.has(chainId)) return []
      const hit = cache.get(chainId)
      if (hit && now() - hit.at < ttl) return hit.tokens
      let p = inflight.get(chainId)
      if (!p) {
        p = load(chainId).finally(() => inflight.delete(chainId))
        inflight.set(chainId, p)
      }
      try {
        const tokens = await p
        cache.set(chainId, { at: now(), tokens })
        return tokens
      } catch (e) {
        if (hit) return hit.tokens
        throw e
      }
    },
  }
}
