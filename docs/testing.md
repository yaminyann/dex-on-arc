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
- Token formatting keeps four significant digits for small amounts and never prints `-0`; positions never go negative and sells without a tracked purchase add no phantom PnL.

`tests/fees-tokens.test.ts` covers the platform fee and the token list: fee settings fail closed (above 100 bps, missing or zero recipient, non-numeric all turn the fee off), fee amount rounding, KyberSwap fee parameters on browser quotes and none on keeper quotes, and the token registry filter (whitelisted only, no honeypot or fee-on-transfer, bad addresses and decimals dropped, text sanitised, http logos dropped, duplicates removed), caching, concurrent-load coalescing, serving the last good list when the registry fails, and no registry call for unsupported chains.
- 0x adapter: "no liquidity" never becomes a quote, firm quote parsing, server-side request validation (unsupported chains, bad amounts and addresses, slippage cap).
- Scaling helpers: cache coalescing, expiry and eviction, failures not cached, rate limiter windows, shard coverage (each id in exactly one shard), backoff growth and cap, chunking, bounded concurrency.

`tests/agent.test.ts` covers the Agent Station and settings: the command parser (every command in several spellings, `$10`, `95,000`, percentages, `all`/`half`, refusal with an example for anything unclear, one token per command), the permission gate (no grant, expiry, scopes, per-command and daily limits, auto-run only with a priced size), clamping of hand-edited permission storage, daily usage reset, and settings sanitising (legacy v1 theme, out-of-range slippage, unknown accents and sizes).

`tests/chat.test.ts` covers the built-in chat rules: token names (bitcoin, ether, solana) resolving to listed symbols, plain wording rewritten into stop-loss, take-profit, limit, OCO, trailing, DCA and market commands (every rewrite must pass the strict parser), a token amount converted to USDC with a note, missing details asked for instead of guessed, questions explained without producing an order, suggestions from holdings (with reasons, no repeat for a protected token, samples to edit without a wallet), and price formatting. `tests/agent-chat-server.test.ts` covers the optional model: off unless configured, the daily budget and its UTC reset, input validation and control-character cleanup, a prompt with no balances or address, model output parsing (code fences, invalid or chained commands dropped, garbage ignored) and the call itself against a mocked endpoint.

## Browser walkthrough (done for every release)

The Agent Station is also walked through live on Arc Testnet: help and balance, the one-time grant, a market buy, a stop-loss, a DCA plan, pause, resume and cancel of the plan, cancelling the order, refusals (unknown token, balance, stop above the price, daily limit), and "run inside limits" mode executing right after the readback.

With a funded testnet wallet (a local signing bridge on loopback, testnet key only) every feature is clicked through in the browser: market swap, stop-loss created and filled by the keeper, DCA create/pause/resume/cancel with refund, OCO create/cancel, portfolio, settings, light and dark themes, mobile width, the mainnet token picker with a live KyberSwap quote and the platform fee row (quote only, no mainnet trade), and the Admin page with the owner wallet (pause/resume, queue/cancel a router change). Docker Compose is built and started locally on a spare port and `/healthz` and `/api/health` are checked before a deployment guide is published.

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

## Live testnet campaign

[test-reports/README.md](test-reports/README.md) holds the latest live campaign against the v2 contract on Arc Testnet: per-scenario results with transaction hashes, what was verified and what was not, and the defects it found. Scripts: `server/testnet/e2e.ts` (order types, DCA, batching), `server/testnet/e2e-security.ts` (access control, timelock, pause, oracle protection, router allowlist, failover), `server/testnet/refill-routers.ts` (top up the test routers). The test routers pay sells from their own USDC, so a full run needs a few USDC of liquidity; testnet USDC comes from a captcha-gated faucet.

## Testnet harness tests

| Suite | Where | What it covers |
| --- | --- | --- |
| Harness contract tests | `contracts/test/TestnetHarness.t.sol` (6 tests) | Faucet cap, feed set and refresh, router quote maths, and the production order contract executing a limit sell, a stop-loss and DCA buys through the test router. |
| Harness unit tests | `tests/trading.test.ts` ("testnet harness") | Deployment record is well formed, test assets are listed first and flagged, testnet uses the test router and mainnet uses 0x. |
| Live end-to-end | `server/testnet/e2e.ts` | Real transactions on Arc Testnet for every order type, cancel, expiry, DCA and a market swap, with a keeper executing. See [testnet-harness.md](testnet-harness.md). |
