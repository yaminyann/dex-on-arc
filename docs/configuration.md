# Configuration

All configuration is environment variables. Secrets stay on the backend and are never prefixed with `VITE_`. Never commit `.env`.

## Frontend (public values only)

Vite exposes only variables that start with `VITE_`. These are public by design.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_ORDERS_ADDRESS_ARC_TESTNET` | For orders on testnet | Deployed `ArcTradeOrders` on Arc Testnet |
| `VITE_ORDERS_ADDRESS_ARC_MAINNET` | For orders on mainnet | Contract you deployed on Arc mainnet |
| `VITE_ORDERS_DEPLOY_TX_ARC_TESTNET` | Optional | Deployment transaction hash. Lets history reads start at the deployment block instead of a bounded lookback |
| `VITE_ORDERS_DEPLOY_TX_ARC_MAINNET` | Optional | Same, for mainnet |
| `VITE_DEFAULT_NETWORK` | Optional (`arc-testnet`) | `arc` or `arc-testnet`. The network a first-time visitor opens on. A visitor's own choice is remembered and wins |

Changing a `VITE_` variable needs a dev-server restart.

## Backend

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_PORT` | `3001` | Backend port. Vite proxies `/api` to it in development |
| `ZEROEX_API_KEY` | none | 0x Swap API key. Without it quotes return `ZEROEX_NOT_CONFIGURED` |
| `PRICE_CACHE_TTL_MS` | `4000` | How long identical `/price` requests share one upstream call |
| `RATE_LIMIT_SCALE` | `1` | Multiplier for per-client rate limits (see [backend-api.md](backend-api.md)) |
| `TRUSTED_PROXY_HOPS` | `0` | Number of reverse proxies in front of the backend. `0` ignores `x-forwarded-for`; set it to `1` behind one proxy so the client address is the one your proxy recorded |
| `ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call `/price` and `/quote`. Defense in depth only; non-browser clients can forge headers |
| `ADMIN_TOKEN` | none | Bearer token for `/metrics` and detailed `/health`. Unset means loopback-only, direct connections. Set it in any deployed environment |
| `UPSTREAM_BUDGET_PER_MIN` | `600` | Cap on requests this process sends to each quote provider per minute, so many clients cannot drain an API key |
| `GATEWAY_PROVIDERS` | `0x,kyber,test-router,test-router-b` | Comma-separated quote providers to use. `0x` needs `ZEROEX_API_KEY`; `kyber` is keyless; the `test-router*` providers answer on Arc Testnet only |
| `GATEWAY_TIMEOUT_MS` | `4000` | Per-provider time limit; a slower provider is dropped for that request |
| `GATEWAY_BREAKER_THRESHOLD` / `GATEWAY_BREAKER_COOLDOWN_MS` | `3` / `30000` | Consecutive failures that take a provider out of rotation, and for how long |
| `GATEWAY_SIMULATE` | on | Set `false` to skip the `eth_call` check of firm quotes (failing quotes are demoted, never trusted) |
| `KYBER_CLIENT_ID` | `arc-terminal` | Client id header sent to KyberSwap |
| `KYBER_ROUTER_ALLOWLIST` | KyberSwap router | Comma-separated router addresses the backend accepts from KyberSwap. Anything else is refused |
| `PLATFORM_FEE_BPS` | `0` | Fee on browser market swaps in basis points of the sell amount (0 = off, max 100). Paid by the aggregator to `PLATFORM_FEE_RECIPIENT` inside the swap. Not charged on orders, DCA, keepers or testnet. See [admin-guide.md](admin-guide.md) |
| `PLATFORM_FEE_RECIPIENT` | none | Address that receives the swap fee. Required when `PLATFORM_FEE_BPS` > 0. An invalid fee setting turns the fee off and logs a warning |
| `ALERT_WEBHOOK_URL` | none | Receives `{"text": "..."}` for keeper and provider alerts (deduplicated, secrets redacted) |
| `VITE_SWAP_TARGETS_ARC` | none | Frontend. Extra reviewed swap contracts (comma-separated) allowed for market swaps on Arc mainnet, in addition to the 0x AllowanceHolder |

## Indexer (optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `INDEXER_ENABLED` | off | `true` starts the event indexer and the `/history`, `/swaps`, `/stats` endpoints |
| `INDEXER_NETWORK` | `arc-testnet` | `arc-testnet` or `arc` |
| `INDEXER_INTERVAL_MS` | `5000` | Poll interval |
| `INDEXER_START_BLOCK` | deployment block | First block to scan when there is no cursor |
| `DATABASE_URL` | `sqlite://./data/indexer.db` | SQLite file or `postgres://...`. Put it on durable storage. See [indexer.md](indexer.md) |

## Keeper (optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `KEEPER_ENABLED` | off | `true` starts the keeper loop |
| `KEEPER_WS_URL` | none | WebSocket RPC (for example `wss://rpc.testnet.arc.io`). New orders and DCA plans end the idle sleep early; polling stays as the fallback |
| `KEEPER_USE_BATCH` | on | Set `false` to send executions one by one even on a v2 contract |
| `KEEPER_BATCH_MAX` | `10` | Most executions per `executeMany` transaction |
| `KEEPER_MIN_TICK_MS` | `1000` | Minimum gap between ticks, so a burst of events cannot hammer the RPC |
| `TESTNET_DEPLOYER_PRIVATE_KEY` | none | Throwaway Arc Testnet key used by the harness scripts (`server/testnet/*`). Never a `VITE_` variable, never a key that held real funds |
| `KEEPER_PRIVATE_KEY` | none | The operator's own funded key. Pays gas, receives the keeper fee. Use a dedicated low-balance key |
| `KEEPER_NETWORK` | `arc-testnet` | `arc-testnet` or `arc` |
| `KEEPER_INTERVAL_MS` | `15000` | Poll interval (500 to 3,600,000) |
| `KEEPER_SHARD_INDEX` | `0` | This instance's shard |
| `KEEPER_SHARD_COUNT` | `1` | Number of keeper instances splitting the work |
| `KEEPER_MAX_ACTIONS_PER_TICK` | `25` | Cap on transactions sent per tick |
| `KEEPER_QUOTE_CONCURRENCY` | `4` | Parallel quote requests |
| `KEEPER_PRIVATE_KEY_FILE` | none | Path to a file holding the key (Docker or Kubernetes secret). Wins over `KEEPER_PRIVATE_KEY` |
| `KEEPER_ROLE` | `primary` | `standby` watches everything and acts only on items that stayed actionable for `KEEPER_STANDBY_GRACE_MS` (default `90000`). Run one alongside primaries for failover |
| `KEEPER_REQUIRE_PROFIT` | `true` | Skip executions whose expected keeper fee does not cover gas. Always off with the testnet test router |
| `KEEPER_PROFIT_MARGIN_BPS` | `0` | Extra margin over break-even, in bps of gas cost |
| `KEEPER_MIN_FEE_USDC_MICRO` | `0` | Absolute minimum expected fee, in millionths of a USDC |
| `KEEPER_MIN_GAS_PRICE_GWEI` | `20` | Fee floor. Arc drops transactions priced below its base-fee floor without an error |
| `KEEPER_BACKOFF_BASE_MS` / `KEEPER_BACKOFF_MAX_MS` | `5000` / `60000` | Per-item retry backoff after a failed execution attempt. Keep it short: a stop-loss that could not fill moments ago may fill seconds later |
| `KEEPER_MIN_BALANCE_USDC` | `1` | The keeper alerts when its USDC balance falls below this |

## RPC selection (backend)

For each chain the backend uses, in order:

1. `RPC_URL_<chain>` (for example `RPC_URL_Arc_Testnet`, `RPC_URL_Arc`): your own provider URL, or several separated by commas. With several, a failing endpoint falls over to the next. Recommended for any deployed keeper.
2. The provisioned proxy (`RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS`) when present. It exists only inside Arc Studio and is never available on other hosts.
3. The public Arc RPC from the generated chain facts.

Provider URLs can embed an API key: keep them out of `VITE_` variables and out of git. Public RPC endpoints may rate-limit; the rate limit is unknown to this project, so measure before relying on it.

## Token and network configuration (code)

`src/trading/networks.ts` defines tokens per network. A token is only tradable for conditional orders when the contract has an oracle feed for it, so adding a token to the file is not enough. Testnet tokens (EURC, cirBTC, WETH) come from the Arc contract-address page. Mainnet tokens are intentionally empty until you review and add them.

## Slippage and expiry defaults

Stored in the browser (local storage): default slippage 0.5% and default order expiry 7 days, both editable in Settings. The contract rejects slippage outside 0.01% to 10%.
