# ArcTradeOrders — Order Types

This document explains each order type and the DCA plan: what it is for, how it is validated at creation, when it triggers, how the minimum output is computed, what happens when execution fails, and who has to call what. See [`contract-reference.md`](./contract-reference.md) for exact signatures and [`security.md`](./security.md) for the threat model.

## 0. Conventions used in all examples

| Item | Value |
|---|---|
| Quote token | USDC, **6 decimals** (1 USDC = `1e6` units) |
| Base token | BTC-like, **8 decimals** (1 BTC = `1e8` units) |
| Prices | `price18` = USDC per 1 whole BTC × 1e18. `60_000e18` means 60,000 USDC per BTC |
| Keeper fee | default 10 bps (0.10%) of swap output, rounded down, paid in the output token |
| Slippage | `maxSlippageBps = 100` (1%) unless stated |
| Starting price | 60,000 USDC per BTC at order creation |

Conversions (rounding down):

- `quoteForBase(1e8, 60_000e18) = 1e8 × 60_000e18 / (1e18 × 10^(8−6)) = 60_000e6`
- `baseForQuote(60_000e6, 60_000e18) = 60_000e6 × 1e18 × 10^2 / 60_000e18 = 1e8`

### 0.1 Common rules (all order types)

- `base != quote`, `amountIn > 0`, `expiry > now`, `1 ≤ maxSlippageBps ≤ 1000` (0.01%–10%), `triggerPrice` and `limitPrice ≤ 2^128−1`.
- Only `LIMIT` may be `BUY`. Every other type must be `SELL`.
- `amountIn` is escrowed at creation (quote for `BUY`, base for `SELL`) and is spent **in full, in one swap**; there are no partial fills.
- Creation requires a fresh, valid oracle price for `base` and `quote`.
- The oracle price is only used to decide whether the order has triggered and to compute the minimum output. The actual execution price comes from the keeper's swap route.
- **Minimum output** is always compared against the *net* amount the owner receives (swap output minus keeper fee).
- **Failure is atomic.** If `execute` reverts for any reason (not triggered, stale oracle, route pays too little, partial fill, disallowed target, pause, …), nothing changes: the order stays `OPEN`, escrow is untouched, and the keeper simply loses gas. The owner can always `cancelOrder`, and anyone can `expireOrder` after `expiry`.
- Order at/after expiry: `execute`, `activateStop` and `pokeTrailing` revert `OrderExpired`; `expireOrder` becomes callable at exactly `expiry`.

### 0.2 Minimum-output formula

```
oracleFloor = floor( converted(amountIn, oraclePrice) × (10000 − maxSlippageBps) / 10000 )
userFloor   = converted(amountIn, userPrice)                    // only for some types
minOut      = max(oracleFloor, userFloor)    (userFloor = 0 when the type has none)
require( swapOutput − floor(swapOutput × keeperFeeBps / 10000)  ≥  minOut )
```

where `converted` is `quoteForBase` for SELL and `baseForQuote` for BUY, and `oraclePrice` is the oracle price at execution time.

| Order type | `userPrice` for the user floor |
|---|---|
| LIMIT | `triggerPrice` |
| TAKE_PROFIT | `triggerPrice` |
| STOP_LIMIT | `limitPrice` |
| OCO | `limitPrice` **only when** the take-profit leg fired (`price ≥ limitPrice`); none on the stop leg |
| STOP_LOSS | none (oracle floor only) |
| TRAILING_STOP | none (oracle floor only) |
| DCA | none (oracle floor only) |

### 0.3 Who calls what

| Action | Function | Who | Notes |
|---|---|---|---|
| Create | `createOrder` | Order owner | Needs token approval; blocked when paused |
| Execute | `execute(id, target, data)` | Any keeper | Pays the keeper fee to the caller; blocked when paused |
| Persist stop condition (stop-limit) | `activateStop(id)` | Anyone | Blocked when paused |
| Persist higher peak (trailing) | `pokeTrailing(id)` | Anyone | **Works while paused** |
| Cancel | `cancelOrder(id)` | Order owner only | Works while paused; no oracle needed |
| Expire & refund | `expireOrder(id)` | Anyone | After `expiry`; refund goes to the owner; works while paused |

Use `checkOrder(id)` (reason codes 0 ready, 1 not open, 2 expired, 3 not triggered, 4 oracle unavailable, 5 paused) to decide what to do off-chain, and `previewOrder(id)` for price and `minOut`.

### 0.4 Creation rules at a glance

| Type | Side | `triggerPrice` | `limitPrice` | `trailBps` | Placement rule vs. current oracle price `P` |
|---|---|---|---|---|---|
| LIMIT | BUY or SELL | required (> 0) | must be 0 | must be 0 | none |
| STOP_LOSS | SELL | required | must be 0 | must be 0 | `trigger < P` |
| TAKE_PROFIT | SELL | required | must be 0 | must be 0 | `trigger > P` |
| STOP_LIMIT | SELL | required (stop) | required (min price) | must be 0 | `trigger < P` and `limit ≤ trigger` |
| TRAILING_STOP | SELL | must be 0 | must be 0 | `10..5000` | none (peak starts at `P`) |
| OCO | SELL | required (lower/stop leg) | required (upper/take-profit leg) | must be 0 | `trigger < P < limit` (both strict) |

All violations revert `InvalidParameters`.

---

## 1. Limit order

**Purpose.** Buy at or below, or sell at or above, a chosen price. The only order type that can be a BUY.

**Side.** `BUY` or `SELL`.

**Creation validation.** Common rules plus: `triggerPrice > 0`, `limitPrice == 0`, `trailBps == 0`. No relation to the current price is enforced, so a limit that is already "in the money" is valid and is executable immediately.

**Trigger.**
- SELL: `price ≥ triggerPrice`
- BUY: `price ≤ triggerPrice`

**Minimum output.** `max(oracleFloor, userFloor)` with `userPrice = triggerPrice`.
- SELL: `userFloor = quoteForBase(amountIn, triggerPrice)` — the owner never receives less than the limit price (net of fee).
- BUY: `userFloor = baseForQuote(amountIn, triggerPrice)` — the owner never receives less base than `amountIn` would buy at the limit price.

**On failure.** Reverts atomically; order stays `OPEN`.

**Who calls what.** Keeper: `execute`. Owner: `cancelOrder`. Anyone: `expireOrder` after expiry.

### Worked example A — limit sell, oracle floor binds

Sell 1 BTC (`amountIn = 1e8`), `triggerPrice = 65_000e18`, slippage 1%. Price rises to 66,000.

- Trigger: `66_000 ≥ 65_000` ✔
- Oracle floor: `quoteForBase(1e8, 66_000e18) = 66_000e6`; ×0.99 = `65_340e6`
- User floor: `quoteForBase(1e8, 65_000e18) = 65_000e6`
- `minOut = max(65_340e6, 65_000e6) = 65_340e6`
- Keeper route returns gross `66_000e6`: fee = `66e6`, net = `65_934e6` ≥ `65_340e6` ✔
- Owner receives `65_934e6`, keeper `66e6`; `executionPrice = 65_934e18`.
- If the route returned only `65_300e6`: fee = `65_300_000`, net = `65_234_700_000` < `65_340_000_000` → `InsufficientOutput(65234700000, 65340000000)`; nothing happens.

### Worked example B — limit sell, user floor binds

Same order but `maxSlippageBps = 1000` (10%) and price 65,100: oracle floor = `65_100e6 × 0.9 = 58_590e6`; user floor = `65_000e6`. `minOut = 65_000e6`. A loose slippage setting cannot push proceeds below the user's limit price.

### Worked example C — limit buy

Escrow 60,000 USDC (`amountIn = 60_000e6`), `triggerPrice = 55_000e18` (maximum price). Price falls to 50,000.

- Trigger: `50_000 ≤ 55_000` ✔
- Oracle: `baseForQuote(60_000e6, 50_000e18) = 120_000_000` (1.2 BTC); ×0.99 = `118_800_000`
- User floor: `baseForQuote(60_000e6, 55_000e18) = 109_090_909`
- `minOut = 118_800_000` (the oracle floor is higher). The net base the owner gets must be ≥ 1.188 BTC.

### Edge cases
- A SELL limit with trigger far below the market, or a BUY limit with trigger far above, is immediately executable; the oracle floor then dominates.
- If the price gaps past the trigger, the user floor still applies: the order simply fails to execute until a route can pay at least the limit price (net of fee).
- Because a failed attempt is free for the owner, keepers may retry as the market moves.

---

## 2. Stop-loss

**Purpose.** Sell when the price falls to a protective level.

**Side.** `SELL` only.

**Creation validation.** Common rules plus: `triggerPrice > 0` and **strictly below** the current oracle price; `limitPrice == 0`; `trailBps == 0`.

**Trigger.** `price ≤ triggerPrice`.

**Minimum output.** Oracle floor only: `floor(quoteForBase(amountIn, price) × (10000 − slippage)/10000)` where `price` is the oracle price *at execution time*, not the trigger price. A stop-loss therefore sells "at market, within slippage of the oracle", even if the market has gapped well below the trigger.

**On failure.** Reverts; order stays `OPEN`. A stop-loss does not latch: if the price rebounds above the trigger before a successful execution, the order is no longer triggered.

**Who calls what.** Keeper: `execute` while `price ≤ trigger`. No latching call exists for this type — the keeper must act while the condition holds.

### Worked example

Sell 1 BTC, `trigger = 55_000e18`, created at 60,000, slippage 1%. Price drops to 54,000.

- Trigger ✔
- `minOut = quoteForBase(1e8, 54_000e18) × 0.99 = 54_000e6 × 0.99 = 53_460e6`
- Route gross `54_000e6`: fee `54e6`, net `53_946e6` ✔ → owner receives `53_946e6`.
- If the price gaps to 50,000 before execution: `minOut = 49_500e6`. The trigger price does not set a floor.

### Edge cases
- Boundary: `price == triggerPrice` triggers (inclusive).
- Stop-loss gives no price guarantee other than the slippage band around the oracle at execution time.

---

## 3. Take-profit

**Purpose.** Sell when the price rises to a target.

**Side.** `SELL` only.

**Creation validation.** Common rules plus: `triggerPrice > 0` and **strictly above** the current oracle price; `limitPrice == 0`; `trailBps == 0`.

**Trigger.** `price ≥ triggerPrice`.

**Minimum output.** `max(oracleFloor, quoteForBase(amountIn, triggerPrice))`. The trigger price doubles as a minimum acceptable price.

**On failure.** Reverts; order stays `OPEN`.

**Who calls what.** Keeper: `execute`. Owner: `cancelOrder`.

### Worked example

Sell 1 BTC, `trigger = 70_000e18`, created at 60,000, slippage 1%. Price reaches 70,500.

- Oracle floor: `70_500e6 × 0.99 = 69_795e6`
- User floor: `70_000e6`
- `minOut = 70_000e6` — the user floor wins because the 1% band around 70,500 reaches below the target.
- Route gross `70_500e6`: fee `70.5e6`, net `70_429.5e6` ✔.
- A route paying gross `70_050e6` would give net `69_979_950_000` < `70_000e6` → `InsufficientOutput`.

### Edge cases
- Because the user floor is the trigger price, the order can fail to fill (and remain open) when the price only briefly touches the trigger and the route's net would fall short of it; this is by design.
- Boundary: `price == triggerPrice` triggers.

---

## 4. Stop-limit

**Purpose.** A stop whose fill price is bounded: once the price falls to the stop level, sell, but never for less than a stated minimum price.

**Side.** `SELL` only.

**Creation validation.** Common rules plus: `triggerPrice > 0` strictly below the current price (the *stop*); `limitPrice > 0` and `limitPrice ≤ triggerPrice` (the *minimum acceptable price*); `trailBps == 0`.

**Trigger.** `stopActivated || price ≤ triggerPrice`. Once `stopActivated` is `true` the order stays triggered regardless of price (the stop has been "hit"); this is the only order type with a latch.

**Activation (persistence).** A reverting `execute` rolls back everything, including the activation it just set. If the stop is hit while the market cannot pay the limit, the activation would be lost and a rebound would leave the order untriggered. To avoid this, anyone can call `activateStop(id)` while `price ≤ triggerPrice`; this permanently sets `stopActivated = true` (event `StopActivated`) even though no swap occurs. A successful `execute` also sets and emits it.

`activateStop` reverts if: paused, expired, the order is not a stop-limit, already activated (`InvalidParameters`), or `price > triggerPrice` (`NotTriggered`).

**Minimum output.** `max(oracleFloor, quoteForBase(amountIn, limitPrice))`. The oracle floor uses the oracle price at execution time, so after a rebound it can be higher than the limit price.

**On failure.** Reverts; stays `OPEN`. If the stop condition holds but the market is below the limit, `execute` fails with `InsufficientOutput`. The activation is *not* persisted by that failed call — call `activateStop` to persist it.

**Who calls what.**
1. Keeper/anyone: `activateStop(id)` when `price ≤ trigger` (important, see above).
2. Keeper: `execute(id, …)` when a route can pay at least `minOut`.
3. Owner: `cancelOrder`; anyone: `expireOrder` after expiry.

### Worked example

Sell 1 BTC, `trigger = 58_000e18` (stop), `limit = 57_000e18`, created at 60,000, slippage 1%.

1. Price 57,500: triggered (≤ 58,000). Oracle floor `57_500e6 × 0.99 = 56_925e6`; limit floor `57_000e6`; `minOut = 57_000e6`. A route paying gross `57_500e6` gives net `57_442.5e6` ✔.
2. Alternatively price 56,000: triggered, but `minOut = max(55_440e6, 57_000e6) = 57_000e6`. Market gross `56_000e6` → net `55_944e6` < `57_000e6` → `InsufficientOutput`. The call reverts and `stopActivated` stays `false`.
3. Anyone calls `activateStop(id)` at price 56,000: `stopActivated = true`.
4. Price recovers to 62,000: still triggered (latched). `minOut = max(62_000e6 × 0.99 = 61_380e6, 57_000e6) = 61_380e6`. Route gross `62_000e6` → net `61_938e6` ✔ → executes.

### Edge cases
- Without a call to `activateStop` (or a successful `execute`) while `price ≤ trigger`, a dip and rebound between keeper checks will leave the order untriggered. Keepers should monitor stop-limit orders and call `activateStop`.
- After activation the order behaves like a limit sell at roughly "no worse than the limit price and within slippage of the oracle". Activation does not cancel or loosen any floor.
- `limitPrice == triggerPrice` is allowed.
- Activation is blocked while the contract is paused and at/after expiry.

---

## 5. Trailing stop

**Purpose.** A stop that follows the price upward: sell when the price falls a set percentage from its highest observed level.

**Side.** `SELL` only.

**Creation validation.** Common rules plus: `trailBps` in `10..5000` (0.10%–50%); `triggerPrice == 0`; `limitPrice == 0`. The initial `peakPrice` is the oracle price at creation.

**Trigger.** With `peak = max(storedPeak, currentPrice)`:

```
price ≤ floor( peak × (10000 − trailBps) / 10000 )
```

**Peak persistence.** The peak is raised and stored (event `TrailingPeakUpdated`) by `pokeTrailing(id)` or by an `execute` that succeeds. A reverting `execute` cannot persist a higher peak, and a price rise followed by a fall *between* two persisting calls is invisible to the contract: the stored peak stays low, so the stop fires later (at a lower price) than the owner intended. Keepers should poke regularly. `pokeTrailing` is callable by anyone, works while the contract is paused (but not after expiry), and is a successful no-op if the price is not above the stored peak.

`previewOrder` / `checkOrder` evaluate with the *virtual* peak `max(storedPeak, price)` without writing.

**Minimum output.** Oracle floor only (no user price).

**On failure.** Reverts; stays `OPEN`.

**Who calls what.** Anyone: `pokeTrailing` (peak maintenance). Keeper: `execute` once triggered. Owner: `cancelOrder`; anyone: `expireOrder`.

### Worked example

Sell 1 BTC, `trailBps = 1000` (10%), slippage 1%, created at 60,000 → stored peak `60_000e18`.

1. Price rises to 66,000 and a keeper calls `pokeTrailing` → peak `66_000e18`.
2. Threshold = `66_000e18 × 9000 / 10000 = 59_400e18`.
3. Price 59,401 → not triggered (`checkOrder` code 3). Price 59,400 → triggered (inclusive).
4. At 59,400: `minOut = 59_400e6 × 0.99 = 58_806e6`. Route gross `59_400e6` → fee `59.4e6`, net `59_340.6e6` ✔.

Without step 1: if the price spiked to 66,000 and fell back to 62,000 with nobody calling `pokeTrailing`, the stored peak would still be 60,000 and the threshold 54,000.

### Edge cases
- If `execute` is called when the price exceeds the stored peak, the peak is written during that transaction, the order is then *not* triggered (the new threshold is below the price), and the call reverts `NotTriggered`; the revert rolls the new peak back, so it is not saved. Use `pokeTrailing`.
- An immediate drop right after creation can trigger the order: with a 5% trail created at 60,000, a price of 56,900 is below the 57,000 threshold.
- The trigger rounds the threshold down, so the order fires at or slightly below the exact percentage.
- The trigger is a one-way ratchet; the peak never decreases.

---

## 6. OCO (one-cancels-the-other)

**Purpose.** A single escrow protected by both a stop-loss leg (lower trigger) and a take-profit leg (upper trigger); whichever fires first executes the whole order, and the order then ends, so the other leg cannot also execute.

**Side.** `SELL` only.

**Creation validation.** Common rules plus: `triggerPrice > 0` (lower, stop leg), `limitPrice > 0` (upper, take-profit leg), `trailBps == 0`, and `triggerPrice < currentPrice < limitPrice` (both strict, so the order is never created already triggered). Note that `limitPrice` here is the *upper trigger*, not a minimum price.

**Trigger.** `price ≤ triggerPrice` (stop leg) **or** `price ≥ limitPrice` (take-profit leg).

**Minimum output.**
- Stop leg: oracle floor only.
- Take-profit leg (`price ≥ limitPrice`): `max(oracleFloor, quoteForBase(amountIn, limitPrice))`.

The leg is chosen from the oracle price at execution time.

**On failure.** Reverts; stays `OPEN`. After a successful execution the order is `EXECUTED` and every later call reverts `OrderNotOpen`; there is no double execution and no refund of the other leg (there is only one escrow).

**Who calls what.** Keeper: `execute`. Owner: `cancelOrder` (cancels both legs). Anyone: `expireOrder`.

### Worked example

Sell 1 BTC, `trigger = 55_000e18` (stop), `limit = 65_000e18` (take-profit), created at 60,000.

- Price 60,000: between legs → not triggered (code 3).
- Price 54,000 (stop leg): `minOut = 54_000e6 × 0.99 = 53_460e6` (no user floor). Route gross `54_000e6` → net `53_946e6` ✔.
- Price 66,000 with slippage 10% (take-profit leg): oracle floor `66_000e6 × 0.9 = 59_400e6`; user floor `quoteForBase(1e8, 65_000e18) = 65_000e6`; `minOut = 65_000e6`.
  With 1% slippage the oracle floor (`65_340e6`) would exceed the user floor, so it would bind instead.
- After execution at 54,000, the price swinging to 70,000 changes nothing: `execute` → `OrderNotOpen`.

### Edge cases
- Boundaries are inclusive on both legs (`price == trigger` and `price == limit` both trigger).
- The stop leg offers no price floor beyond the oracle slippage band, as with a plain stop-loss.
- There is no latch: if neither leg is satisfied at the moment a keeper executes, the call reverts.

---

## 7. DCA (dollar-cost averaging) plan

**Purpose.** Spend a fixed amount of quote token on a base token at regular intervals, from a single up-front deposit.

**Side.** Always "buy base with quote". DCA is a separate object (`createDca`, `executeDca`, `Dca` struct), not an `Order`.

**Creation validation (`createDca(base, amountPerBuy, numBuys, interval, firstExecution, maxSlippageBps, maxPrice)`).**
- `base != quote`; `amountPerBuy > 0`; `1 ≤ numBuys ≤ 520`; `interval ≥ 3600` seconds; `maxPrice ≤ 2^128−1` (0 = no cap); `1 ≤ maxSlippageBps ≤ 1000`.
- Fresh, valid oracle price for base and quote at creation.
- `firstExecution == 0` means "now"; a non-zero value is used as given (a past value means due immediately).
- The entire budget `amountPerBuy × numBuys` is pulled from the caller in the quote token at creation (the deposit must arrive exactly).
- Not available while paused.

**Trigger (per buy).**
1. Plan is `ACTIVE` with budget remaining.
2. `block.timestamp ≥ nextExecution`.
3. If `maxPrice != 0`: oracle `price ≤ maxPrice` (else `PriceAboveCap`). The cap is on the **oracle** price, not on the realized swap price.

**Minimum output.** Oracle floor only: `floor( baseForQuote(amountIn, oraclePrice) × (10000 − maxSlippageBps)/10000 )`, where `amountIn = min(amountPerBuy, budgetRemaining)`. It applies to the net base the owner receives (after the keeper fee). The keeper fee is paid in **base** from the swap output.

**Schedule.** After each buy, `scheduled = nextExecution + interval`. If `scheduled ≤ now`, the next execution is `now + interval` instead. Missed buys are never backfilled and at most one buy occurs per call. When the budget reaches zero the plan becomes `COMPLETED`.

**On failure.** Reverts atomically; plan state is unchanged; the keeper can retry.

**Who calls what.**
- Keeper: `executeDca(id, target, data)` when due (blocked while paused).
- Plan owner: `pauseDca`, `resumeDca`, `cancelDca` (all work while the contract is paused; `cancelDca` needs no oracle).
- `resumeDca` sets `nextExecution = max(nextExecution, now)`, so resuming never schedules in the past.
- `cancelDca` is available for `ACTIVE` and `PAUSED` plans and refunds `budgetRemaining`; not for `COMPLETED` or `CANCELLED` plans (`DcaNotCancellable`).
- There is no expiry for a plan.

Use `checkDca(id)` (0 ready, 1 not active, 2 not due, 3 price above cap, 4 oracle unavailable, 5 paused) and `previewDca(id)`.

### Worked example

`amountPerBuy = 1_000e6` (1,000 USDC), `numBuys = 4`, `interval = 1 day`, `maxSlippageBps = 100`, `maxPrice = 70_000e18`, BTC at 60,000. Deposit: `4_000e6`.

- Oracle base amount: `baseForQuote(1_000e6, 60_000e18) = 1_000e6 × 1e18 × 100 / 60_000e18 = 1_666_666` (0.01666666 BTC).
- `minOut = floor(1_666_666 × 9900 / 10000) = 1_649_999`.
- Route gross `1_666_666`: fee = `floor(1_666_666 × 10 / 10000) = 1_666`; net = `1_665_000` ≥ `1_649_999` ✔. Owner gets `1_665_000` sats; keeper gets `1_666` sats.
- Schedule: first buy at creation time `T` (if `firstExecution = 0`) → `nextExecution = T + 1 day`.
- If the oracle reads 70,500: `PriceAboveCap(70500e18, 70000e18)`; nothing is spent, the plan stays `ACTIVE`, and the keeper retries after the price falls.
- If the first buy only happens at `T + 3 days + 5 hours`, `nextExecution = (that time) + 1 day` and only one buy occurred.
- After the 4th buy, `budgetRemaining == 0`, status `COMPLETED`, events `DcaExecuted` then `DcaCompleted`.

### Edge cases
- A buy executed on time (at or shortly after `nextExecution`) advances the schedule by exactly one `interval` from the previous `nextExecution`, keeping the cadence. A buy executed so late that `nextExecution + interval ≤ now` (including exactly equal) re-bases the schedule to `now + interval`.
- Pausing a plan and resuming later: the next execution is "now" if the old schedule has passed, so exactly one buy is due immediately, not a backlog.
- If the base token's feed is disabled or stale, buys fail but `cancelDca` still refunds.
- Dust: if the oracle-implied base amount for `amountPerBuy` is so small that the net output is zero, the buy cannot execute (`InsufficientOutput(0, …)`).
- The price cap does not protect against a route that is worse than the oracle by up to `maxSlippageBps`; that is the slippage setting's job.
- Rounding: `amountPerBuy × numBuys` is exact, so the budget is always an exact multiple of `amountPerBuy`; every buy spends exactly `amountPerBuy`.
