# Automation and keepers

Smart contracts cannot run themselves. Something must notice that an order's condition is met and submit the transaction. This project makes execution **permissionless**: any address can call the execution entry points, and the caller earns an onchain keeper fee. Users do not need to run a bot or keep a browser open.

## What a keeper calls

| Function | Purpose | Pays the caller? |
| --- | --- | --- |
| `execute(id, target, data)` | Run a triggered order through an allowlisted swap target | Yes: keeper fee on output |
| `executeDca(id, target, data)` | Run a due DCA buy | Yes |
| `expireOrder(id)` | Refund an expired open order to its owner | No |
| `activateStop(id)` | Persist that a Stop-Limit stop price was crossed | No |
| `pokeTrailing(id)` | Persist a new price high for a Trailing Stop | No |

Maintenance calls (`activateStop`, `pokeTrailing`) matter: a reverted `execute` rolls back the activation or new peak, so a trailing stop only follows the market if a keeper records highs while price rises, and a stop-limit only stays active if a keeper recorded the crossing.

The keeper fee starts at 0.10% of the swap output and can only ever be lowered by the owner. The user's minimum output is checked after the fee.

## Researched automation providers on Arc (2026-11-11)

| Provider | Status | Notes |
| --- | --- | --- |
| Built-in keeper (`server/keeper.ts`) | Available | Run it yourself |
| Any third-party keeper | Available | The contract is permissionless |
| Chainlink CRE | Unverified | Live on Arc Testnet only, depends on your tenant, not on mainnet. No adapter built |
| Chainlink Automation | Unsupported | No evidence of an Arc deployment |
| Gelato Web3 Functions | Unsupported | Shut down on 2026-03-31 |
| Thyme Flow | Unverified | Gelato's successor; confirm Arc support with its CLI before relying on it |

The backend exposes this list at `/health` and the UI shows it in the Execution and automation card. The project does not claim automation that does not exist: if no keeper is running, triggered orders wait.

## Built-in keeper

Start it with `KEEPER_ENABLED=true`, `KEEPER_PRIVATE_KEY=<dedicated funded key>` and `KEEPER_NETWORK`. See [configuration.md](configuration.md) for every option.

### Tick algorithm

1. Read `nextOrderId` and `nextDcaId`.
2. **Discover**: for ids it has not seen (and that belong to its shard), read `getOrder` / `getDca` in Multicall3 batches and remember the open ones.
3. **Refresh**: for open items not in backoff, read `[getOrder, checkOrder]` (or `[getDca, checkDca]`) in batches of 50 items per request. Drop items that are no longer open.
4. **Classify**: expired orders, trailing orders whose price exceeds the stored peak, stop-limit orders whose stop was crossed, and executable items.
5. **Act**, up to `KEEPER_MAX_ACTIONS_PER_TICK`: maintenance calls first, then fetch 0x quotes with bounded concurrency, verify the target is allowlisted, simulate, and send.
6. **Backoff**: items that fail simulation, have no route or revert go on exponential backoff (30 s doubling to 10 min) so they cannot starve healthy items.

Since Phase 1 the act step works like this:

- **Quotes** come from the gateway (0x and KyberSwap). The keeper takes the best-ranked quote whose target the contract owner has allowlisted, so adding a second aggregator needs a timelocked `queueSwapTarget` for its router.
- **Gas estimation is the simulation.** `estimateContractGas` reverts for items that are not executable; those back off.
- **Profitability.** For each execution the expected keeper fee (on output for sells, approximated from the input for buys and DCA) must cover the gas cost plus `KEEPER_PROFIT_MARGIN_BPS`. Unprofitable items are skipped and counted in `skippedUnprofitable`. The contract has no minimum order size, so dust orders are never executed by a profit-requiring keeper; they are refunded at expiry. Set `KEEPER_REQUIRE_PROFIT=false` to execute everything anyway.
- **Concurrent sends.** All prepared transactions are broadcast back to back with explicit nonces from the chain's pending count and confirmed in parallel. A failed send stops the batch and the next tick re-reads the nonce.
- **Gas price floor** of 20 gwei (`KEEPER_MIN_GAS_PRICE_GWEI`) so Arc does not silently drop transactions.
- **Failover.** Run a `KEEPER_ROLE=standby` instance next to your primaries. It watches every item but acts only after an item stayed actionable for the grace period, so it stays idle while primaries are healthy and takes over when they are not. No shared store is needed because every call is permissionless and idempotent.
- **Batching (v2 contracts).** When two or more executions are ready, the keeper sends them in one `executeMany` transaction (up to `KEEPER_BATCH_MAX`, default 10). Each item was already simulated alone, so only items that passed are batched; if the batch estimate fails the keeper falls back to single sends. After the receipt it counts which `OrderExecuted` events actually appeared, so an item the contract skipped (`BatchItemFailed`) backs off instead of being counted as done. On a v1 contract (no `minOrderQuote`) batching switches itself off. Set `KEEPER_USE_BATCH=false` to disable.
- **Event wake.** With `KEEPER_WS_URL` set, `OrderCreated`, `DcaCreated` and `DcaResumed` events end the idle sleep early (rate-limited by `KEEPER_MIN_TICK_MS`). Polling remains the fallback, so a dropped socket costs latency only. Price triggers still depend on polling; there is no oracle-update subscription yet.
- **Keys** can be mounted as a file (`KEEPER_PRIVATE_KEY_FILE`). KMS or HSM signing is not built.

The keeper reads state from the contract, not from event logs. A restart rebuilds its working set from the chain, so there is no block-0 backfill and no persisted cursor to lose.

### On Arc Testnet

0x does not support testnet, so the keeper only performs maintenance there (expiry refunds, stop activation, trailing peaks). It cannot swap.

### Economics

The operator pays gas in USDC and earns the keeper fee. A tick with nothing to do costs only RPC reads. Profitability depends on order sizes versus gas; Arc fees are predictable and low, but measure on your own traffic. The base fee has a 20 gwei floor, so transactions priced below it are dropped without an error.

## Running several keepers

Two patterns, both safe because execution is idempotent (a second execute on a closed order reverts):

- **Sharding**: run N instances with `KEEPER_SHARD_COUNT=N` and distinct `KEEPER_SHARD_INDEX` values. Each id belongs to exactly one shard (`id % N`), so instances never compete.
- **Competition**: run independent keepers on different keys without sharding. The first confirmed transaction wins; others simply revert at simulation, which costs them no gas because they simulate before sending.

## Writing your own keeper

Minimum viable loop:

1. Iterate order ids `1 .. nextOrderId-1`; skip closed ones.
2. Call `checkOrder(id)`; if `executable` is true, request a 0x firm quote with `taker = the contract`, sell/buy tokens as the order's side implies, `sellAmount = order.amountIn`.
3. Check `swapTargets(quote.transaction.to)`.
4. Simulate and send `execute(id, to, data)`.
5. For trailing orders call `pokeTrailing` when `checkOrder`'s price exceeds `peakPrice`; for stop-limit call `activateStop` when the price is at or below the stop.
6. Call `expireOrder` after `expiry`.

Reason codes from `checkOrder` are in [contract-reference.md](contract-reference.md).

## Failure handling

| Situation | Result |
| --- | --- |
| Quote shows no liquidity | Item backs off; retried later |
| Swap output below the minimum | `execute` reverts; order stays open; stop-limit and trailing state set by maintenance calls persists |
| Target not allowlisted | Keeper logs a warning and backs off |
| RPC error | Tick fails with `lastError` set; next tick retries from scratch |
| Keeper out of gas funds | Transactions fail; fund the keeper address |
| Contract paused | Executions revert; refunds and cancels still work |
