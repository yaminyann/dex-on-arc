# Pull requests to open (stacked)

GitHub could not be reached with a credential the agent was allowed to use, so the three branches are pushed and these are ready to paste. Open them in this order, each against the previous branch (retarget to `main` as each one merges).

| # | Compare link | Base | Title |
| --- | --- | --- | --- |
| 1 | https://github.com/yaminyann/dex-on-arc/compare/main...phase-1-gateway-keeper | `main` | Phase 1: quote gateway, keeper hardening, observability |
| 2 | https://github.com/yaminyann/dex-on-arc/compare/phase-1-gateway-keeper...phase-2-indexer-history | `phase-1-gateway-keeper` | Phase 2: event indexer, history API, verified swap reports |
| 3 | https://github.com/yaminyann/dex-on-arc/compare/phase-2-indexer-history...phase-3-contract-v2 | `phase-2-indexer-history` | Phase 3: contract v2 (unaudited), keeper batching, live testnet campaign |

**None of these PRs authorises a mainnet deployment.** The contract is unaudited; see `docs/mainnet-readiness-checklist.md`.

---

## PR 1: Phase 1: quote gateway, keeper hardening, observability

Adds a multi-aggregator quote gateway and hardens the keeper. (The P0 security fixes already landed on `main` earlier.)

- **Gateway** (`server/gateway/`): 0x and KyberSwap (keyless, API verified live against Arc mainnet), plus the two testnet routers as providers. Parallel quotes ranked by `minBuyAmount` minus gas, per-provider timeout, budget and circuit breaker, `eth_call` simulation that demotes broken quotes. KyberSwap router and sell amount are validated; the browser pins swap targets and approval spenders.
- **Shared price cache**: `/price` is cached per pair, not per wallet (the wallet's allowance is read separately). 800 requests from 80 wallets cost 4 upstream lookups.
- **Keeper**: quotes via the gateway, profit gate, explicit nonces, back-to-back broadcast, standby role, key from file, multi-RPC fallback, WebSocket wake on new orders.
- **Observability**: Prometheus output, webhook alerts, secrets redacted.
- Testnet rehearsal: second test router queued as a timelocked swap target (the rehearsal for allowlisting an extra aggregator on mainnet).

Verification: 11/11 live testnet end-to-end scenarios on the v1 harness through the new keeper and gateway; bun tests, typecheck, lint clean.

## PR 2: Phase 2: event indexer, history API, verified swap reports

- Indexes every order-contract event into SQLite (default) or Postgres through Bun SQL: idempotent writes, cursor, adaptive range size; logs decoded locally because a topic filter listing every event exceeds the public RPC limit.
- `GET /history`, `/swaps`, `/stats`, `POST /swaps`. A swap report is only a transaction hash; the backend re-derives amounts from the receipt, so a forged report can only fail verification. Found and fixed live: Arc emits a gas-fee `Transfer` from `0xff…fe` that must be ignored.
- Frontend reports confirmed swaps and merges verified server swaps into Trade history.
- Backend integration tests (rate limit cannot be bypassed with `x-forwarded-for`, `/metrics` needs the operator token), a load test (99.5% cache hits), and a mainnet-fork script against the real KyberSwap router (stock anvil cannot move Arc USDC; the script detects that and exits with code 2).
- Frontend vendor chunk splitting.

## PR 3: Phase 3: contract v2 (unaudited), keeper batching, live testnet campaign

**Contract v2 (testnet only, needs an audit before any mainnet use):** owner-set minimum order size, queued config that expires after 14 days, `ConfigQueued` carrying its content, oracle round completeness check, paged and batched views, `executeMany` with per-item isolation (self-call-only `executeFor`), `renounceOwnership` disabled. 16 new Foundry tests (191 total). Runtime size 23,778 of 24,576 bytes; CI now runs `forge build --sizes`.

**Keeper:** batches two or more ready orders into one `executeMany`; short retry backoff (5 s to 60 s); tries every allowlisted provider quote best-first.

**Live testnet campaign** (`docs/test-reports/README.md`, with transaction hashes):

- Verified live: DCA, stop-loss, take-profit, expiry refund, cancel refund (including with a dead oracle and while paused), `executeMany` (three keeper transactions, one with a skipped item), timelock (exactly 3,600 s, early apply rejected, cancel), access control (11 admin functions), oracle protection (stale, future-dated, mismatched round, zero, negative, reverting).
- Also verified live on a clean state after the fixes: OCO and stop-limit fill, and the keeper failing over from an empty router A to router B (receipts checked).
- **Not verified live** (test routers ran out of USDC; the faucet is captcha-gated): a batch of three, the last three hostile-calldata cases, and the scripted disable-router failover scenario. Scripts are ready to finish them.
- Defects the campaign found, all fixed: keeper and script sharing one key, a 10-minute backoff, no fallback to a second provider, and the v2 contract exceeding the size limit.

`docs/mainnet-readiness-checklist.md` lists every blocker (audit, oracle plan, fork test with real calldata, multisig owner, 48 h delay, KMS for the keeper key).
