# Testing

## Commands

| Command | What it runs |
| --- | --- |
| `bun run contracts:test` | Foundry test suite for the contract |
| `bun test` | Application unit tests (`tests/trading.test.ts`) |
| `bun run check` | Lint (oxlint, type-aware) and typecheck of the app and of the server and tests |

## Contract tests (169)

Located in `contracts/test/`. Shared mocks in `ArcTradeMocks.sol`: configurable-decimals ERC-20, a reentrant token, a settable Chainlink-style aggregator, a swap target that behaves like AllowanceHolder, and a malicious swap target that under-delivers or spends less than the input.

| File | Count | Coverage |
| --- | --- | --- |
| `Config` | 29 | Constructor bounds, timelock queue/apply/cancel, immediate disables, keeper fee only decreasing, ownership, decimals bounds |
| `Lifecycle` | 22 | Create, cancel, expire and refund for every order type, validation reverts |
| `Execute` | 19 | Happy paths on 6, 8 and 18-decimal bases, keeper fee payout, user price floors, no leftover approvals |
| `Advanced` | 21 | Stop-limit activation persistence, trailing peak and reversal, OCO legs, preview/check views |
| `ExecRevert` | 30 | Every failure: not triggered, stale/zero/negative price, unallowlisted target, partial fill, under-delivery, zero output, expired, paused |
| `Dca` | 24 | Schedule, late execution without backfill, pause/resume/cancel, price cap, completion, fuzzed budget conservation |
| `Security` | 11 | Reentrancy through hostile tokens and hostile swap targets on all entry points |
| `Fuzz` | 9 | Price conversion against a 512-bit reference, monotonicity, round trips, trailing threshold |
| `Invariant` | 4 | Balance covers open escrow, exact equality (no stranded dust), no standing approvals, DCA accounting |

Run a subset: `forge test --match-path 'contracts/test/ArcTradeOrders.Dca.t.sol'`. Deeper fuzzing: `forge test --fuzz-runs 5000`.

What these tests do not cover: behaviour against real Chainlink feeds, the real 0x contracts, or real USDC (blocklist, proxy upgrades). Cover those with a fork test on mainnet before deploying.

## Application tests

`tests/trading.test.ts` runs with Bun and covers pure logic:

- Order math matches the contract convention for 6/8/18-decimal tokens, zero-price safety, slippage floors, input parsing, DCA sizing.
- Positions: average entry, realized/unrealized PnL, partial sells, open orders excluded, unknown decimals skipped.
- Candles: 4h aggregation, SMA/EMA.
- 0x adapter: "no liquidity" never becomes a quote, firm quote parsing, server-side request validation (unsupported chains, bad amounts and addresses, slippage cap).
- Scaling helpers: cache coalescing, expiry and eviction, failures not cached, rate limiter windows, shard coverage (each id in exactly one shard), backoff growth and cap, chunking, bounded concurrency.

## Manual and integration checks

These need a wallet or network access and are not automated:

| Check | How |
| --- | --- |
| Wallet connect and chain switch | Connect an injected wallet, switch networks in the header |
| Approve and create order | Needs an oracle feed; use your own deployment with a feed |
| Cancel and refund | Create an order, cancel it from Open orders |
| Market swap | Arc mainnet, 0x key set, small amount |
| Keeper | Run with a dedicated key against your deployment; watch `/metrics` and `/health` |
| Failure cases | Stop the backend (expect "Quote service offline"), remove the API key (expect the key notice), use testnet (expect disabled controls with reasons) |

A mainnet fork is the best place for an end-to-end rehearsal: fork Arc mainnet, deploy the contract, queue real feeds and the real AllowanceHolder, advance time past the delay, and run a keeper against real 0x quotes.

## Adding tests

- Contract: add a file under `contracts/test/` that extends the base test and reuse the mocks.
- App: add cases to `tests/trading.test.ts`. Keep tests pure; do not call live APIs from unit tests.
- Any change to math must be mirrored in both `ArcTradeOrders.sol` and `src/trading/math.ts` with a test that pins known values.

## Lint and typecheck notes

The app is checked with `tsc` and type-aware oxlint. Server and tests use Bun types and are checked by `tsconfig.server.json`, which the `typecheck` script runs after the app check. React purity rules apply: do not call `Date.now()` during render (use `useNowSeconds`) and do not set state synchronously in effects.

## Backend integration tests

`tests/server.integration.test.ts` starts the real backend as a child process (no providers, keeper or indexer, so no network) and checks the abuse controls end to end: rotating `x-forwarded-for` cannot bypass the rate limit, `/metrics` needs the operator token, public `/health` hides the keeper address, and `POST /swaps` needs a running indexer.

## Load test

`scripts/load-test.ts` simulates many wallets asking for prices on a few pairs and reports throughput, latency percentiles, rate-limit hits, cache hit ratio and which provider answered. Start the backend with a high `RATE_LIMIT_SCALE` (every simulated wallet shares one IP), then:

```bash
bun run scripts/load-test.ts --url http://localhost:3001 --chain 5042002 --requests 800 --wallets 80 --concurrency 40
```

Reference run on this project (local backend, Arc Testnet, public RPC): 800 requests from 80 wallets finished in 5.8 s (137 requests/s), all 200, 4 upstream lookups (99.5% cache hits), p50 under 1 ms, p95 1.8 s (cold per-wallet allowance reads), max 5.8 s. Mainnet quotes through KyberSwap: 120 requests, 2 upstream lookups, p50 307 ms. Numbers depend on your RPC and network; measure on your own setup.

## Mainnet fork test

`scripts/fork-mainnet-test.ts` runs the order contract against the real KyberSwap router and real Arc pools on a local fork: a real keeper-style fill, plus hostile variants (output sent to the keeper, non-allowlisted target, wrong amount, cancel). It needs a fork client that emulates Arc's native-USDC precompile. Stock anvil reads USDC balances but every USDC transfer reverts, so the script detects this, prints why and exits with code 2. It was verified up to that precheck (fork, deploy, timelock jump, Kyber route and build); the scenarios themselves have not been run. Use Arc's Foundry fork to run them.

## Testnet harness tests

| Suite | Where | What it covers |
| --- | --- | --- |
| Harness contract tests | `contracts/test/TestnetHarness.t.sol` (6 tests) | Faucet cap, feed set and refresh, router quote maths, and the production order contract executing a limit sell, a stop-loss and DCA buys through the test router. |
| Harness unit tests | `tests/trading.test.ts` ("testnet harness") | Deployment record is well formed, test assets are listed first and flagged, testnet uses the test router and mainnet uses 0x. |
| Live end-to-end | `server/testnet/e2e.ts` | Real transactions on Arc Testnet for every order type, cancel, expiry, DCA and a market swap, with a keeper executing. See [testnet-harness.md](testnet-harness.md). |
