# ArcTradeOrders — Security Notes

This document describes the trust model, threat model, review history, test coverage, known limitations and suggested audit focus for `contracts/ArcTradeOrders.sol`. It reflects the source as written. See [`contract-reference.md`](./contract-reference.md) for the full function-level behaviour and [`order-types.md`](./order-types.md) for order semantics.

---

## 1. Trust model and assumptions

### 1.1 What the contract does *not* trust

| Actor / input | Treatment |
|---|---|
| Keeper (any caller of `execute`, `executeDca`) | Fully untrusted. Chooses only *when* to call and the swap `target` + `data`. Cannot choose recipients of funds, cannot spend a different amount than the order's `amountIn`, cannot use a non-allowlisted target. The result is judged purely by balance deltas and a minimum output. |
| Order owner | Can only act on their own orders. Cannot affect other users' escrow or the contract's config. |
| Swap target's return data | Ignored. Revert data is bubbled; success is judged by balances. |
| Price on a DEX | Not used. Triggers and minimum output come from the oracle. |

### 1.2 What the contract *does* trust

| Assumption | Consequence if violated |
|---|---|
| **Owner** acts honestly, uses a secure account (multisig recommended), and honours the config timelock. | A malicious owner can, after the delay, register a manipulated feed or a hostile swap target and then profit from orders left open (see T1). The owner cannot touch escrow directly. |
| **Price feeds** are honest, Chainlink-compatible, return `decimals()` consistent with their answers, and update within their configured `maxStaleness`. | Wrong prices trigger orders wrongly and loosen/tighten minimum output. |
| **Quote and base tokens** are plain, non-rebasing, non-fee-on-transfer ERC-20s with accurate `decimals()` and no hooks that misbehave. | Fee-on-transfer tokens are rejected at deposit; rebasing or otherwise exotic balance behaviour can break accounting (T7). |
| **Allowlisted swap targets** are real DEX routers/aggregators whose behaviour is bounded by the exact approval, and are *not* token contracts or other contracts for which `ArcTradeOrders` itself holds privileges. | The contract calls the target as `msg.sender` with arbitrary keeper-chosen calldata (see T3). |
| The chain provides standard `block.timestamp` and EVM semantics. | |

### 1.3 Powers summary

| Power | Owner | Keeper | Order owner |
|---|---|---|---|
| Withdraw/redirect escrow | No | No | Own order only (cancel / expiry refund) |
| Change an existing order | No | No | No |
| Add or change a feed, add a swap target | Yes, after `configDelay` | No | No |
| Disable a feed or swap target | Yes, immediately | No | No |
| Raise keeper fee | No (never) | No | No |
| Lower keeper fee | Yes | No | No |
| Pause new escrow / executions | Yes | No | No |
| Block cancels, expiry refunds, DCA cancels | No | No | No |

---

## 2. Threat model

| # | Threat | Mitigation in code | Residual risk |
|---|---|---|---|
| T1 | **Adversarial or compromised owner** (swap in a malicious feed or target, grief by pausing/disabling) | All additions of feeds/targets go through a timelock of `configDelay` (1 h–14 d, immutable; ≥ 48 h recommended) and an explicit `applyConfig`. Pending changes can be cancelled. Owner has no function that moves escrow; no upgrade path; no rescue. `setKeeperFeeBps` can only decrease. Cancels, expiry refunds and DCA cancel/pause/resume never depend on owner state, the oracle or the pause flag. The target is re-validated at apply time (not zero, not this contract, has code). | After the delay a malicious owner could install a manipulated feed plus a hostile target and extract value from users who did not exit during the window. Users must watch `ConfigQueued` and cancel in time. The owner can instantly **pause** or **disable** a token/target to stop executions (a stop-loss then cannot fire), though funds stay recoverable. `ConfigQueued` does not include what is queued and `_pendingConfigs` is not readable on-chain (see §6). `renounceOwnership` is not disabled: renouncing while paused would leave execution permanently off (refunds still work). |
| T2 | **Malicious keeper calldata** (steal output, spend wrong amount, sandwich) | Target must be allowlisted. Exact `amountIn` approval, zeroed right after the call. Input spent must equal `amountIn` exactly (`PartialFill` otherwise); input balance increase is rejected. Output measured as a balance delta that must not decrease; `net = received − fee` must be ≥ `minOut` and non-zero. Output must land in the contract, so a route sending output to the keeper yields zero and reverts. Owner is paid by the contract itself. | A keeper (or MEV searcher) can pick a route that is worse than the market by up to the order's slippage tolerance (≤ 10% of the oracle-implied output), and for limit-style orders no worse than the user's price floor. Slippage is relative to the oracle, not to a DEX quote. Users should choose small `maxSlippageBps`. |
| T3 | **Malicious or compromised swap target** | Allowlist + timelock to add; instant `disableSwapTarget` to remove. The target only ever receives approval for one order's `amountIn` of the input token, and none persists. The same balance-delta and exact-spend checks apply regardless of target honesty. | The call is made *from* the contract with arbitrary data, so a target that is itself a token (or a contract over which the contract holds privileges) could be called in unintended ways, e.g. a `transfer` of another token's escrow, which the checks (which only watch `tokenIn` and `tokenOut`) would not see. The code only forbids `address(0)`, `address(this)` and code-less addresses. **Allowlist only audited routers; never allowlist a token.** A compromised router can return less than market value up to the slippage band. A target can also return large revert/return data to burn the keeper's gas. |
| T4 | **Oracle manipulation, staleness, decimals errors** | Per-feed `maxStaleness` (60 s–48 h) with `StalePrice` on zero, future or old timestamps; `answer ≤ 0`, reverting feeds and zero scaled prices → `InvalidPrice`. Feed and token decimals read at apply time, bounded (token ≤ 59, feed ≤ 77) and scaled to 18 decimals; scaling overflow checked. Price is `baseUsd / quoteUsd`, so both feeds must be live and a quote depeg is reflected. `checkOrder`/`checkDca` swallow feed failures (code 4) so off-chain monitors do not break. Stop-limit, limit, take-profit and OCO's TP leg also have a user price floor independent of slippage. | Round metadata (`roundId`, `answeredInRound`) is not checked; there is no min/max answer bound, no deviation guard, no sequencer-uptime check, and decimals are cached (a feed that later changes its decimals is not detected). A manipulated or lagging feed can trigger stop-loss/trailing/OCO-stop legs wrongly, and those have only an oracle-relative floor. A new feed takes effect on existing open orders after the timelock. Staleness is a bound, not a freshness guarantee: prices up to `maxStaleness` old are accepted. |
| T5 | **Reentrancy** (token hooks, swap target callbacks, malicious recipients) | Every state-changing external function is `nonReentrant`, including the owner/admin functions. `createOrder` / `createDca` / `cancel*` / `expireOrder` write state before token transfers. In `execute` / `executeDca` the swap call happens before the terminal state write, but any re-entry reverts with `ReentrancyGuardReentrantCall`, and the payouts occur after state is final. Tested with a hooked ERC-20 and a hostile swap target against create, cancel, execute, expire and cancelDca. | Read-only reentrancy: view functions are not guarded, so a contract called during the swap sees the order as still `OPEN`. Integrators should not trust this contract's views from inside a swap callback. |
| T6 | **Balance-delta reliance / donation** | Deltas are measured in-transaction around the swap. Donated tokens are not part of any order's accounting, so they cannot unlock escrow or alter amounts; they are simply unrecoverable. A target that hands input back, spends too little/much, or reduces output balance is rejected. | Tokens sent directly to the contract are permanently stranded (no rescue by design). Exact-spend over the whole token balance means the swap cannot consume other users' escrow of the same token. |
| T7 | **Fee-on-transfer and rebasing tokens** | `_pull` requires the balance to increase by exactly the requested amount (`TransferAmountMismatch`), rejecting fee-on-transfer tokens on deposit. Escrow is tracked per order by nominal amounts, not by balance. | Not supported and not fully detectable: tokens that charge fees on *outgoing* transfers deliver less than the contract sends (minOut is checked on what the contract receives, not what the owner finally gets); negative rebases make the contract insolvent for the last withdrawers; positive rebases leave surplus stuck; blocklisting tokens can freeze an individual payout (only that order is affected because each payout is its own transaction). Only list well-behaved tokens. |
| T8 | **Griefing via failed executions / spam** | Failed executions revert atomically and cost only the caller's gas; they cannot lock, alter or consume the order. Cancel/expire/refund paths never depend on the oracle, target or pause. Anyone can call `expireOrder`, `pokeTrailing`, `activateStop`. Order ids are per-creation and independent. | Anyone can create tiny orders (no minimum size) and bloat per-account id arrays and off-chain indexes. A hostile owner could cause keepers' attempts to revert by pausing or disabling a feed/target. Keepers pay gas for attempts that fail on routes or on-chain drift between simulation and inclusion. |
| T9 | **Front-running of keeper executions** | `execute` is permissionless and the fee goes to `msg.sender`; the owner's outcome depends only on `minOut`, never on who calls or in what order. An order executes at most once (status check). A user cancelling just before inclusion makes the keeper's call revert `OrderNotOpen` (gas only). | A copycat can replay a keeper's profitable call with its own calldata first and take the fee; the keeper loses the race. Sandwiching around the swap itself is possible within the slippage tolerance (see T2). Orders are public, so triggers and fees are visible to searchers. |
| T10 | **Pause semantics abuse / lockout** | `pause` only blocks `createOrder`, `createDca`, `execute`, `executeDca`, `activateStop`. `cancelOrder`, `expireOrder`, `pokeTrailing`, `pauseDca`, `resumeDca`, `cancelDca` stay available. | While paused, protective orders (stops, trailing) cannot execute; prices may move far and orders may expire un-executed (refund only). DCA schedules do not backfill on unpause. |
| T11 | **Timelock semantics weakness** | `changeId` includes a nonce and the full request, so identical requests produce distinct ids and cannot collide. Pending entries are deleted before being applied (no replay). Cancellable. `configDelay` is immutable and bounded. Instant powers (`disableToken`, `disableSwapTarget`, `setKeeperFeeBps` down, `pause`) can only reduce functionality or fees. | Queued entries never expire: a stale entry can be applied arbitrarily later. The timelock protects only if users monitor it. There is no on-chain way to read what is queued (events omit content). Applying a token change replaces the whole `TokenConfig` including `maxStaleness`. |
| T12 | **Partial fills** | None allowed. Exact-spend rule: `spent == amountIn` or revert. DCA buys always spend exactly `amountPerBuy` (budget is an exact multiple). | Large orders may fail to find a single route with enough liquidity; the order stays open (the owner can cancel). |
| T13 | **Rounding and dust** | All conversions round down (`quoteForBase`, `baseForQuote`, slippage floor, keeper fee, realized price). Round trips never inflate (fuzz-tested). Zero net output is rejected, avoiding zero-denominator realized prices and zero-pay executions. Scaling uses `mulDiv`; decimals are bounded so powers of ten fit. | Rounding can leave the owner at most one smallest unit different from an ideal computation. The keeper fee rounds down, so tiny outputs pay the keeper nothing. Trailing thresholds round down, making the trigger very slightly stricter. Feeds with more than 18 decimals lose precision on scaling. |
| T14 | **Timestamp limits** | Stored times are `uint40` and checked (`TimestampOverflow`). Expiry must be in the future. | `expiry` and `firstExecution` can be set arbitrarily far in the future (up to `uint40`). |
| T15 | **Stale latched state (stop-limit / trailing)** | `activateStop` persists a stop-limit trigger; `pokeTrailing` persists trailing peaks, both permissionless. A reverting `execute` cannot persist either. | Persistence depends on someone calling in time. If nobody does, a dip-and-rebound (stop-limit) or spike-and-fall (trailing) between calls is missed and the order may fire late or not at all. Owners can call these functions themselves. |

---

## 3. Execution safety properties (summary)

1. Escrow leaves the contract only to the order owner, the keeper fee recipient (caller of `execute` / `executeDca`, from the swap output only), or the swap target (exactly `amountIn` of the input token, via approval).
2. For every execution: `inputSpent == amountIn`; `outputReceived` is a balance delta ≥ 0; `net = received − floor(received × feeBps / 10000) ≥ minOut` and `net > 0`.
3. The approval to the swap target is exactly `amountIn` during the call and zero afterwards.
4. Order terminal states are absorbing: an order cannot execute twice, nor execute after cancel/expiry.
5. The contract's balance of each token equals the sum of open escrow (absent donations), checked by invariant tests.

---

## 4. Audit history (in plain terms)

| Stage | Finding | Resolution |
|---|---|---|
| Security review | **Mutable configuration.** Originally the owner could change price feeds and swap targets immediately, so a compromised or malicious owner could alter the pricing and the set of trusted swap contracts underneath open orders with no warning to users. | Introduced the **config timelock**: `queueTokenConfig` / `queueSwapTarget` → wait `configDelay` → `applyConfig`, with `cancelConfig`. Only risk-reducing actions (`disableToken`, `disableSwapTarget`, lowering the keeper fee, pause) remain instant. Tests: config suite. |
| Security review | **Stop-limit persistence.** A stop-limit's "stop hit" status was only set inside `execute`. If the swap failed (for example the market was below the limit price), the whole transaction reverted and the activation was lost. If the price then rebounded, the order would no longer be triggered and the protection silently disappeared. | Added `activateStop(id)`, a permissionless call that latches `stopActivated` while the price is at or below the stop, independent of any swap. `execute` still sets the flag for the successful path. `pokeTrailing` provides the equivalent permissionless persistence for trailing-stop peaks. Tests: advanced suite. |
| Static analysis | Reported **balance-delta reentrancy** (state written after external calls that were preceded by balance reads) in the execution and deposit paths. | Reviewed as **false positives**: every state-changing external function is `nonReentrant`, so no re-entrant call can observe or modify the intermediate state; the balance reads exist precisely to measure the effect of the external call within the same transaction. Verified by reentrancy tests using a hooked token and a hostile swap target (see §5). |
| Static analysis | Reported **strict equality** warnings on balance comparisons (`spent != amountIn`, deposit delta `!= amount`, and similar). | Reviewed as **false positives**: the comparisons are on in-transaction *deltas*, deliberately exact (exact-spend rule and exact-deposit rule). A third party cannot manipulate a delta by donating tokens in a way that grants value: a donation would not change the delta of an honest swap, and one made by the swap target in the middle of the call causes a revert, not a payout. Comparisons of `eta == 0` and `price == 0` are existence / sentinel checks. |

This is a history of the project's own reviews. It is not a substitute for an independent audit.

---

## 5. Test coverage summary

169 Foundry tests (165 unit/fuzz tests + 4 invariants), under `contracts/test/`, run against mock ERC-20s (6/8/18 decimals), a configurable Chainlink-style aggregator, an honest swap target, and a malicious swap target / hooked token.

| Suite | File | Tests | Covers |
|---|---|---|---|
| Config | `ArcTradeOrders.Config.t.sol` | 29 | Constructor bounds, Ownable2Step, queue/apply/cancel timelock, id uniqueness, decimals bounds, disabling tokens and targets, keeper fee lowering only, pause permissions, USD price scaling, `currentPrice` |
| Lifecycle | `ArcTradeOrders.Lifecycle.t.sol` | 22 | Creation and escrow for all types, creation validation (shape, price placement, trailing params, uint128 bound, unsupported base, allowance, stale oracle), cancel (all types, paused, dead oracle), expiry, pause on create |
| Execute | `ArcTradeOrders.Execute.t.sol` | 19 | Happy-path executions across 8- and 18-decimal bases for limit/stop/take-profit, keeper fee and owner proceeds, `minOut` rules (user price vs slippage floor), no standing approvals |
| Advanced | `ArcTradeOrders.Advanced.t.sol` | 21 | Stop-limit activation and persistence, trailing peaks and threshold boundary (incl. fuzz), OCO legs and no double execution |
| Execute-revert paths | `ArcTradeOrders.ExecRevert.t.sol` | 30 | Every `execute` failure: not triggered, invalid/non-open, stale/invalid/future/negative/broken oracle, disabled token, non-allowlisted/disabled target, bubbled and empty reverts, partial fills (half, none, returned input), under-delivery, net below `minOut`, zero output, expiry edges, pause, all `checkOrder` codes |
| DCA | `ArcTradeOrders.Dca.t.sol` | 24 | Creation bounds and escrow, execution payout and fee, scheduling and no-backfill, 18-decimal base, price cap, slippage floor, pause/resume/cancel, refunds, `checkDca` codes |
| Security / reentrancy | `ArcTradeOrders.Security.t.sol` | 11 | Pause semantics across all functions; reentrancy through a hooked token (create, cancel, execute, executeDca) and through a hostile swap target (cancel, re-execute, second order, create, expire, DCA cancel) |
| Fuzz | `ArcTradeOrders.Fuzz.t.sol` | 9 | `quoteForBase`/`baseForQuote` exactness against a reference across decimals, round trip never inflates, monotonicity, known values, zero-price revert, limit proceeds never below user limit price (sell and buy), DCA budget conservation |
| Invariants | `ArcTradeOrders.Invariant.t.sol` | 4 | With a random-walk handler (create, execute, cancel, expire, DCA, price and time moves): balance covers open escrow; balance equals open escrow exactly; no standing approval to the swap target; DCA accounting consistent (`budgetRemaining + totalSpent` is a multiple of `amountPerBuy`, `totalSpent == executions × amountPerBuy`, completed ⇒ zero budget) |

Not covered by the suite: real DEX routers, real Chainlink feeds, fee-on-transfer or rebasing tokens as bases, tokens with transfer blocklists, multi-user adversarial economics, gas profiling, formal verification.

---

## 6. Known limitations

- **Single quote token** per deployment; one base per order; no native-token support; no multi-hop awareness (the keeper's route can be anything that satisfies the checks).
- **No partial fills.** Orders are all-or-nothing.
- **No rescue or recovery.** Tokens transferred to the contract outside the intended flows are unrecoverable. Positive rebases are stranded.
- **Oracle-only triggers.** There is no on-chain DEX price check. Execution quality is bounded by oracle-relative minimum output (slippage up to 10%) and the user's own price floor for LIMIT, TAKE_PROFIT, STOP_LIMIT and OCO's TP leg. STOP_LOSS, TRAILING_STOP, OCO's stop leg and DCA have only the oracle-relative floor, and DCA's `maxPrice` caps the oracle price, not the realized price.
- **Oracle hygiene gaps:** no round-completeness check, no deviation/circuit-breaker bounds, no sequencer-uptime feed, cached decimals.
- **Keeper dependence** for liveness: stops, trailing peaks, stop-limit activation and DCA all need someone to call at the right time. There is no built-in incentive for `activateStop` / `pokeTrailing` (only `execute` / `executeDca` pay a fee).
- **Config opacity:** `ConfigQueued` emits only an id and ETA; the pending request is not readable on-chain; queued entries never expire; the timelock only helps if monitored.
- **Instant owner levers** (pause, disable) can prevent protective executions even though refunds remain available.
- **`renounceOwnership` is available**; renouncing makes config frozen and, if done while paused, execution permanently disabled.
- **Swap target policy is a social/operational control:** the contract only checks non-zero, not self, has code. It cannot tell a router from a token.
- **Execution accounting order:** in `execute` and `executeDca`, terminal state is written after the swap call and before payouts (relying on `nonReentrant` during the swap call), rather than strictly before every external interaction.
- **Unbounded per-account id arrays** (`getOrderIds`, `getDcaIds`) can grow without limit and make those views expensive for heavy users.
- **Fee asymmetry:** the keeper fee is taken from output at the global rate at execution time; lowering it affects existing orders (favourably for users).
- **Return-data copy:** a hostile allowlisted target can return arbitrarily large data, increasing the keeper's gas.
- Orders cannot be edited; changing terms requires cancelling and recreating.

---

## 7. Suggested focus for a third-party audit

1. **`_swap` and the approval/balance-delta pattern** with exotic ERC-20s (tokens requiring zero-first approvals, return-less `transfer`, hooks such as ERC-777, blocklists, rebasing) and with hostile targets, including targets that interact with other tokens held by the contract.
2. **Swap-target governance:** whether the allowlist rules (non-zero, not self, has code) are sufficient, and operational guidance for what may be allowlisted.
3. **Oracle integration:** staleness semantics, round data, decimals caching, quote-feed dependence, behaviour on L2 sequencer outages or feed migration, and whether additional bounds are needed.
4. **Math:** `quoteForBase` decomposition, `baseForQuote` double-floor, `_realizedPrice`, trailing threshold rounding, extreme decimals (0 and 59), `uint128` price bounds, overflow reverts.
5. **State machines:** order and DCA lifecycles, stop-limit latch, trailing peak persistence, DCA schedule arithmetic (`nextExecution`), resume semantics, pause interactions.
6. **Reentrancy and ordering:** confirm that every state-changing path is guarded, review the execute-then-write ordering, and consider read-only reentrancy for integrators.
7. **Timelock and admin:** queue/apply/cancel edge cases, entries that never expire, instant-disable semantics (disabling the quote token), `Ownable2Step`, `renounceOwnership`, `pause` behaviour.
8. **Economic review:** keeper/MEV extraction within slippage bands, griefing and spam economics, fee design.
9. **Event completeness for monitoring** (especially `ConfigQueued`) and indexer assumptions.
