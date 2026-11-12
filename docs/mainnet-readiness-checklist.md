# Mainnet readiness: security review checklist

Status as of the testnet campaign described in [test-reports/README.md](test-reports/README.md), which lists what was verified live, what was not, and the defects it found. **Nothing here authorises a mainnet deployment.** The contract is unaudited, v2 has only run on Arc Testnet, and several items below are still open. Mainnet is deployed and operated by the project owner after an independent audit.

Legend: **Done** = verified by an automated or live test (evidence given). **Partial** = some evidence, a gap remains. **Open** = not done, blocks mainnet. **Owner** = a decision or action only the project owner can take.

## 1. Contract (ArcTradeOrders v2)

| # | Item | Status | Evidence / gap |
| --- | --- | --- | --- |
| 1.1 | Independent third-party audit of the exact bytecode and compiler settings | **Open (blocker)** | None. v2 additions (executeMany, executeFor self-call, minimum order size, expiring config) are new surface |
| 1.2 | Unit, fuzz and invariant tests pass | Done | 191 Foundry tests (Foundry v1.7.1), including 16 for v2 |
| 1.3 | Runtime size under the 24,576-byte limit | Done | 23,778 bytes; CI runs `forge build --sizes` |
| 1.4 | Escrow can only leave to the owner, the keeper fee recipient or the exact-amount swap target | Partial | Invariant tests pass. Live: unknown targets rejected; the live check that hostile calldata leaves escrow and allowances untouched did not finish (test router out of USDC), see the test report |
| 1.5 | Reentrancy: all state-changing paths guarded; `executeFor` reachable only by the contract | Done | Foundry hostile-target test; `NotSelf` check |
| 1.6 | Owner cannot withdraw escrow; no upgrade path; no rescue | Done | Code review; access-control live scenario |
| 1.7 | Config changes timelocked, visible, expiring | Done | Live scenario "timelock": delay 3600 s on testnet, early apply rejected, cancel works, `ConfigQueued` carries content |
| 1.8 | Mainnet `configDelay` at least 48 hours | **Owner** | Testnet harness uses 1 hour. Deploy mainnet with 172,800 s or more |
| 1.9 | Owner is a multisig, with signers and a recovery plan | **Owner** | Not set up |
| 1.10 | Oracle: stale, future-dated, mismatched-round, non-positive and reverting feeds rejected | Done | Live scenario "oracle" (testnet fixture feed) and Foundry tests |
| 1.11 | Oracle quality on mainnet: Chainlink feeds have a 24 h heartbeat and about 0.5% deviation threshold | **Open** | Stop-loss and trailing triggers follow a lagging price. A low-latency or second oracle (Data Streams, Pyth) with a deviation guard is not built |
| 1.12 | `renounceOwnership` disabled; two-step ownership transfer | Done | Live scenario "ownership" |
| 1.13 | Pause blocks creation and execution but never cancel, refund or expiry | Done | Live scenario "pause" |
| 1.14 | Minimum order size to keep dust out | Done (testnet) | Live: 0.05 USDC rejected with minimum 0.1. Choose the mainnet value deliberately |
| 1.15 | Fee-on-transfer, rebasing and blocklist tokens | **Open** | Documented as unsupported (security.md T7). Only list plain tokens; test each real token on a fork |
| 1.16 | Swap-target policy: never allowlist a token or any contract that holds privileges over the orders contract | **Owner** | The contract only checks non-zero, not self, has code. Governance rule, not code |
| 1.17 | Real aggregator calldata survives the exact-spend and net-output checks | **Open** | `scripts/fork-mainnet-test.ts` is written but stock anvil cannot move Arc USDC; needs Arc's Foundry fork |

## 2. Swap routing and backend

| # | Item | Status | Evidence / gap |
| --- | --- | --- | --- |
| 2.1 | Rate limit cannot be bypassed with a forged `x-forwarded-for` | Done | Integration test and live check (30 forged requests, 20 allowed) |
| 2.2 | `/metrics` and detailed `/health` need operator access; public view redacts keeper address and errors | Done | Integration test |
| 2.3 | Browser pins swap targets and approval spenders; rejects native value | Done | Unit tests (`assertSafeSwapQuote`) |
| 2.4 | KyberSwap router address and sell amount validated; unexpected router refused | Done | Unit tests with live-shaped fixtures; router has code on Arc mainnet |
| 2.5 | 0x AllowanceHolder address and 0x API behaviour on Arc | **Partial** | Address has code on Arc mainnet; never exercised with a real 0x key |
| 2.6 | Router(s) allowlisted on the mainnet contract through the timelock | **Owner** | Testnet rehearsal done with a second test router |
| 2.7 | Gateway degrades gracefully (timeouts, breaker, budgets, fallback) | Partial | Unit tests; the keeper failed over from an empty router A to router B live (receipts checked). The explicit disable-router-then-failover scenario did not finish live |
| 2.8 | `GATEWAY_SIMULATE` eth_call check demotes broken quotes | Partial | Unit tests; skipped when allowance is insufficient |
| 2.9 | Secrets stay out of logs and alerts | Done | `redactSecrets` tests; verified live that an RPC URL in an error is redacted |

## 3. Keeper and operations

| # | Item | Status | Evidence / gap |
| --- | --- | --- | --- |
| 3.1 | Executes DCA, stop-loss, take-profit, trailing, OCO, stop-limit, expiry refunds | Done except trailing re-run | Live on v2: DCA, stop-loss, take-profit, expiry refund; trailing and OCO passed in an earlier v2 run. OCO and stop-limit fill re-verified on a clean state after the keeper fixes. Trailing stop re-run on v2 after the fixes is pending. All eleven passed on the v1 harness |
| 3.2 | Batches ready orders into one `executeMany` | Done (2 orders per batch) | Three keeper `executeMany` transactions, one with a skipped item (`BatchItemFailed`). A batch of three completing fully is pending |
| 3.3 | Profit gate, gas floor, explicit nonces, standby failover | Partial | Unit tests and live runs; mainnet gas economics unmeasured |
| 3.4 | Keeper key never shared with another sender | Done | Found by the live run: a shared key raced the explicit nonces. The testnet keeper now has its own key |
| 3.5 | Keeper retry backoff short enough for stop-losses | Done | Found by the live run: a 10-minute backoff delayed a stop-limit. Default now 5 s base, 60 s cap |
| 3.6 | Keeper key in a KMS or HSM | **Open** | File-mounted secret only |
| 3.7 | Monitoring and paging | Partial | Prometheus and webhook alerts exist; no dashboards, no on-call |
| 3.8 | Indexer on durable storage | Partial | SQLite works; Postgres untested |
| 3.9 | Multiple RPC providers with failover | Partial | Supported by configuration; not load tested |

## 4. Before any mainnet step

1. Close the blockers: audit (1.1), oracle plan (1.11), fork test with real calldata (1.17).
2. Decide owner multisig, 48 h or longer delay, token list with feeds, minimum order size, keeper fee.
3. Rehearse the whole procedure once more on testnet with the production configuration values.
4. Launch with caps: allowlisted pairs only, small per-order and total limits, a pause drill, an incident playbook that has been practised.
5. Re-run the live test campaign against the mainnet-parameter testnet deployment and keep the report with the audit.
