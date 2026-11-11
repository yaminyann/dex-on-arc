import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

/**
 * Starts the real backend as a child process (no providers, no keeper, no indexer, so no network is
 * needed) and checks the abuse controls end to end: the behaviour the P0 fixes are meant to guarantee.
 */
const PORT = 3400 + Math.floor(Math.random() * 400)
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'integration-test-admin-token'
let proc: ReturnType<typeof Bun.spawn>

async function waitReady(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('backend did not start')
}

beforeAll(async () => {
  proc = Bun.spawn(['bun', 'run', 'server/index.ts'], {
    env: {
      ...process.env,
      API_PORT: String(PORT),
      ADMIN_TOKEN: TOKEN,
      GATEWAY_PROVIDERS: 'none',
      KEEPER_ENABLED: 'false',
      INDEXER_ENABLED: 'false',
      TRUSTED_PROXY_HOPS: '0',
      RATE_LIMIT_SCALE: '1',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await waitReady()
})

afterAll(() => {
  proc?.kill()
})

const QUOTE = 'chainId=5042&sellToken=0x3600000000000000000000000000000000000000&buyToken=0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1&sellAmount=1000000&taker=0x0000000000000000000000000000000000000001'

describe('backend abuse controls (integration)', () => {
  test('rotating x-forwarded-for cannot get around the per-client rate limit', async () => {
    let limited = 0
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${BASE}/quote?${QUOTE}`, { headers: { 'x-forwarded-for': `10.1.0.${i}` } })
      if (r.status === 429) limited++
    }
    // /quote allows 20 per minute per client; the other 10 must be refused no matter what the header says.
    expect(limited).toBeGreaterThanOrEqual(10)
  })

  test('/metrics needs the operator token, and a forwarded header never grants loopback access', async () => {
    expect((await fetch(`${BASE}/metrics`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(403)
    expect((await fetch(`${BASE}/metrics`)).status).toBe(403) // a token is configured, so loopback alone is not enough
    expect((await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    const prom = await fetch(`${BASE}/metrics?format=prometheus`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(prom.headers.get('content-type')).toContain('text/plain')
    expect(await prom.text()).toContain('# TYPE arc_http_requests_total counter')
  })

  test('public /health hides the keeper address and raw errors', async () => {
    const body = (await (await fetch(`${BASE}/health`)).json()) as { keeper: { keeperAddress: string | null }; gateway: { configured: boolean } }
    expect(body.keeper.keeperAddress).toBeNull()
    expect(body.gateway.configured).toBe(false)
  })

  test('with no provider configured quotes say so instead of failing oddly', async () => {
    const r = await fetch(`${BASE}/price?${QUOTE}`)
    expect([400, 503]).toContain(r.status)
  })

  test('only GET is accepted, except the swap report which needs a running indexer', async () => {
    expect((await fetch(`${BASE}/price`, { method: 'POST' })).status).toBe(405)
    const swap = await fetch(`${BASE}/swaps`, { method: 'POST', body: '{}' })
    expect(swap.status).toBe(503)
    expect(((await swap.json()) as { error: { code: string } }).error.code).toBe('INDEXER_DISABLED')
  })

  test('input validation runs before anything else', async () => {
    const r = await fetch(`${BASE}/price?chainId=abc`)
    expect(r.status).toBe(400)
  })
})
