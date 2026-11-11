# Backend API

The backend is a small Bun HTTP server (`server/index.ts`). In development Vite proxies `/api/*` to it and strips the prefix, so the browser calls `/api/price` and the server sees `/price`. All endpoints are `GET`, return JSON, and send `cache-control: no-store`.

## Endpoints

### `GET /health`

Provider and keeper status for the UI.

```json
{
  "ok": true,
  "zeroEx": { "configured": true, "chains": [5042] },
  "keeper": { "enabled": true, "running": true, "network": "arc-testnet", "keeperAddress": "0x...",
              "lastTick": 1794408379561, "lastError": null, "executed": 0,
              "shard": { "index": 0, "count": 1 }, "openOrders": 0, "openDcas": 0, "backedOff": 0, "notes": [] },
  "automationProviders": [ { "id": "local-keeper", "name": "...", "state": "active", "summary": "...", "evidence": "..." } ]
}
```

### `GET /metrics`

Counters for operators.

| Field | Meaning |
| --- | --- |
| `uptimeSeconds` | Time since start |
| `http.requests`, `rateLimited`, `cacheHits`, `cacheMisses`, `upstreamErrors` | Request accounting. Hit ratio = hits / (hits + misses) |
| `http.priceCacheEntries` | Entries currently held |
| `keeper.ticks`, `lastTickMs` | Loop count and last tick duration |
| `keeper.openOrders`, `openDcas` | Items currently tracked in this shard |
| `keeper.rpcMulticalls` | Batched read requests issued |
| `keeper.executed`, `failedExecutions`, `maintenanceCalls`, `skippedBackoff` | Actions and skips |

`/metrics` exposes no secrets. Do not put it on the public internet unauthenticated if you consider operational counters sensitive.

### `GET /price` and `GET /quote`

Indicative price (`/price`) and firm quote with a transaction (`/quote`) from 0x AllowanceHolder.

| Query parameter | Rules |
| --- | --- |
| `chainId` | Integer. Only `5042` is accepted. Anything else returns `CHAIN_NOT_SUPPORTED` |
| `sellToken`, `buyToken` | Token addresses, must differ |
| `sellAmount` | Positive integer in base units |
| `taker` | Address that will hold the sell token (the user for market swaps, the order contract for keeper execution) |
| `slippageBps` | Integer 0 to 1000 (default 50) |

Successful response (fields the app uses; others are dropped):

```json
{
  "liquidityAvailable": true,
  "sellToken": "0x...", "buyToken": "0x...",
  "sellAmount": "1000000", "buyAmount": "...", "minBuyAmount": "...",
  "route": [ { "from": "...", "to": "...", "source": "Uniswap_V3", "proportionBps": "10000" } ],
  "fees": {}, "issues": { "allowance": { "actual": "0", "spender": "0x..." } },
  "totalNetworkFee": "...", "transaction": { "to": "0x...", "data": "0x...", "value": "0", "gas": "..." },
  "zid": "..."
}
```

`transaction` is present only for `/quote`. When no route has liquidity the body is `{ "liquidityAvailable": false }` and no amounts are returned: the app shows "no route", never an estimate.

## Caching and coalescing

`/price` responses are cached for `PRICE_CACHE_TTL_MS` (default 4 s) per unique request, and concurrent identical requests share one upstream call. The response header `x-cache` is `hit` or `miss`. `/quote` is never cached because it returns executable calldata. Failed upstream loads are not cached by the loader, but an upstream HTTP error body returned by 0x is cached for the TTL like any response.

## Rate limiting

Fixed one-minute windows per client (the socket address, or the trusted-proxy address when `TRUSTED_PROXY_HOPS` is set):

| Bucket | Default per minute |
| --- | --- |
| `/price` | 90 |
| `/quote` | 20 |
| everything else | 240 |

Limits scale with `RATE_LIMIT_SCALE`. Over the limit the server returns `429` with `retry-after` seconds.

## Errors

All errors use `{ "error": { "code": "...", "message": "..." } }`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `INPUT_INVALID` | 400 | A query parameter failed validation |
| `CHAIN_NOT_SUPPORTED` | 400 | 0x does not support that chain (Arc Testnet) |
| `ZEROEX_NOT_CONFIGURED` | 503 | `ZEROEX_API_KEY` is not set |
| `RATE_LIMITED` | 429 | Too many requests from this client |
| `UPSTREAM_ERROR` or a 0x error name (for example `TOKEN_NOT_SUPPORTED`) | upstream status | 0x rejected the request |
| `UPSTREAM_UNREACHABLE` | 502 | The backend could not reach 0x |
| `METHOD_NOT_ALLOWED` | 405 | Non-GET request |
| `NOT_FOUND` | 404 | Unknown route |

## Abuse and trust controls

- **Client identity**: by default the rate-limit key is the socket address and `x-forwarded-for` is ignored, because clients can set it to anything. Behind your own reverse proxy set `TRUSTED_PROXY_HOPS` to the number of proxies; the address that many entries from the right is used.
- **Global upstream budget**: `UPSTREAM_BUDGET_PER_MIN` (default 600) caps all calls to 0x from this process. When exceeded, `/price` and `/quote` return `503 UPSTREAM_BUDGET_EXCEEDED`.
- **Origin gate**: with `ALLOWED_ORIGINS` set, `/price` and `/quote` require a matching `Origin` or `Referer`, otherwise `403 ORIGIN_NOT_ALLOWED`. This stops casual use from other sites; it is not authentication.
- **Operator endpoints**: `/metrics` returns `403` unless the request carries `Authorization: Bearer $ADMIN_TOKEN`. Without `ADMIN_TOKEN` only a direct loopback connection without `x-forwarded-for` qualifies. The public `/health` omits the keeper address and replaces raw keeper errors (which can embed RPC URLs) with a generic message.
- **Frontend pinning**: the browser accepts a market-swap transaction or approval spender only if it names a contract in `NETWORKS[...].swapTargets` (the 0x AllowanceHolder on Arc mainnet, the test router on testnet) and sends no native value. A compromised or spoofed backend cannot make the wallet sign a transaction to another contract through this path.

## Security notes

- The 0x API key is read from the environment per request and never returned, logged or placed in a response.
- Validation runs before any upstream call; addresses and amounts are checked with strict patterns.
- The server accepts no user key material.
- If you deploy behind a proxy, make sure it appends the real client address to `x-forwarded-for` and set `TRUSTED_PROXY_HOPS`; otherwise all clients share the proxy's rate-limit bucket.
