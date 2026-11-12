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

`/health` also reports `agentChat` (`{ "enabled": true }` when the optional chat model is configured) and `platformFee` (`{ "bps": 30 }` or `null`). Operators additionally get `platformFee.recipient` and `platformFeeProblem` (why a configured fee was turned off).

### `POST /agent-chat`

Optional. Body `{ "text": string (1 to 300 chars), "tokens": string[] (symbols, at most 80), "quote": string }`. Returns `{ "reply": string, "command": string | null }`, where `command` is a single line that already passed the strict command parser. Errors: `503 AGENT_CHAT_DISABLED` (not configured), `400 INPUT_INVALID`, `413` (body over 4 KB), `429 AGENT_CHAT_BUDGET` (daily budget used) or `RATE_LIMITED`, `502 AGENT_CHAT_UNAVAILABLE` (the model did not answer). See [agent-station.md](agent-station.md).

### `GET /tokens?chainId=5042`

The tradable token list for the swap picker, from KyberSwap's public registry (keyless), cached 10 minutes with the last good list served if the registry is down. Only whitelisted tokens that are not flagged honeypot or fee-on-transfer are returned; text is sanitised and logos must be https. Chains without a registry (testnet) return `{ "tokens": [] }`. Being listed means the aggregator can route the token, not that it is safe.

```json
{ "tokens": [ { "address": "0xbef5...", "symbol": "EURC", "name": "EURC", "decimals": 6, "logoURI": "https://..." } ] }
```

### `GET /admin-events?limit=200`

Owner actions from the indexer (`ConfigQueued`, `ConfigCancelled`, `TokenConfigured`, `SwapTargetSet`, `KeeperFeeSet`, `MinOrderQuoteSet`, `Paused`, `Unpaused`, ownership events), newest first. Public chain data; the Admin page rebuilds the token, router and pending-change lists from it and confirms them against the chain. `503 INDEXER_DISABLED` when the indexer is off.

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

When `PLATFORM_FEE_BPS` is set, browser requests carry the fee: the quote's `buyAmount` is already net of it and the response includes `platformFee: { bps, amount }` (amount in sell-token base units).

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

## Quote gateway

`/price` and `/quote` no longer talk to one aggregator. The gateway (`server/gateway/`) asks every configured provider in parallel (today: 0x and KyberSwap), drops providers that are unconfigured, unsupported, over their budget, timed out or in an open circuit breaker, and ranks the rest by guaranteed output (`minBuyAmount`) minus gas when the buy token is USDC. Firm quotes are checked with an `eth_call` from the taker; a failing quote is demoted below passing ones.

The response keeps the fields above and adds:

| Field | Meaning |
| --- | --- |
| `provider` | Winning provider (`0x` or `kyber`) |
| `alternatives` | Every valid quote in rank order (`provider`, `buyAmount`, `minBuyAmount`, `simulation`) |
| `providers` | What each provider did (`quote`, `no_liquidity`, `error`, `timeout`, `breaker_open`, `budget`, `unconfigured`, `unsupported`) with timing |
| `simulation` | `ok`, `failed` or `skipped` (skipped when the taker's allowance is insufficient) |

Trust rules per provider: the KyberSwap router the API returns must be in `KYBER_ROUTER_ALLOWLIST`, and the quoted sell amount must equal the request. The browser additionally pins every transaction target and approval spender (see Abuse and trust controls). A keeper uses the same ranking with `taker = the orders contract`, takes the best quote whose target the contract owner has allowlisted, and skips the `eth_call` check.

Adding a provider: implement `QuoteProvider` (`server/gateway/types.ts`), normalize to `GatewayQuote`, register it in `server/gateway/instance.ts`, add its router to the frontend `swapTargets` and queue it on the orders contract (timelocked) before keepers can use it.

### Testnet providers

Arc Testnet has no real aggregator, so the gateway also serves `test-router` and `test-router-b`, the two deployed `TestSwapRouter` contracts from the harness record. They price at the public test feeds minus 0.10% and exist so that the whole path (gateway ranking, keeper selection among allowlisted targets, execution) can be rehearsed on testnet before mainnet. Limit providers with `GATEWAY_PROVIDERS`.

## History endpoints

`GET /history`, `GET /swaps`, `GET /stats` and `POST /swaps` come from the optional indexer and are described in [indexer.md](indexer.md).

## Observability

`GET /metrics` (operator only) returns JSON. `GET /metrics?format=prometheus` (or `Accept: text/plain`) returns Prometheus text with request, cache, keeper action, keeper balance, last-OK-tick age and per-provider `arc_gateway_provider_up` series. Set `ALERT_WEBHOOK_URL` to be notified when the keeper wallet runs low, ticks fail three times in a row, or a quote provider's breaker opens (one message per condition per 15 minutes, plus one on recovery).

## Caching and coalescing

`/price` responses are cached for `PRICE_CACHE_TTL_MS` (default 4 s) per pair, amount and slippage, and concurrent identical requests share one gateway round trip. The cache key leaves the wallet out: the shared lookup uses a neutral taker, and the caller's own allowance for the quoted spender is read separately (an `eth_call`, also cached for the TTL) and added as `issues.allowance`. A load test with 80 wallets and 800 requests produced 4 upstream lookups (99.5% hit ratio). The response header `x-cache` is `hit` or `miss`. `/quote` is never cached because it returns executable calldata. Failed upstream loads are not cached by the loader, but an upstream HTTP error body returned by 0x is cached for the TTL like any response.

## Rate limiting

Fixed one-minute windows per client (the socket address, or the trusted-proxy address when `TRUSTED_PROXY_HOPS` is set):

| Bucket | Default per minute |
| --- | --- |
| `/price` | 90 |
| `/quote` | 20 |
| `/agent-chat` | 12 |
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
