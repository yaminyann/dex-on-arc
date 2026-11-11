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

## Application tests (24)

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

## Testnet harness tests

| Suite | Where | What it covers |
| --- | --- | --- |
| Harness contract tests | `contracts/test/TestnetHarness.t.sol` (6 tests) | Faucet cap, feed set and refresh, router quote maths, and the production order contract executing a limit sell, a stop-loss and DCA buys through the test router. |
| Harness unit tests | `tests/trading.test.ts` ("testnet harness") | Deployment record is well formed, test assets are listed first and flagged, testnet uses the test router and mainnet uses 0x. |
| Live end-to-end | `server/testnet/e2e.ts` | Real transactions on Arc Testnet for every order type, cancel, expiry, DCA and a market swap, with a keeper executing. See [testnet-harness.md](testnet-harness.md). |
