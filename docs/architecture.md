# Architecture

## System overview

```
                         +---------------------------+
                         |        Browser (UI)       |
                         |  React, wagmi, viem       |
                         +-----+---------------+-----+
        wallet signs txs |     | reads (RPC,   | /api/*
                         |     | multicall)    |
                +--------v--+  |        +------v--------------+
                | Arc RPC   |<-+        |  Backend (Bun)      |
                +--------+--+           |  - 0x proxy + cache |
                         ^              |  - rate limiting    |
                         |              |  - keeper (optional)|
              +----------+-----+        +------+--------+-----+
              | ArcTradeOrders |<--- execute --+        | HTTPS + API key
              | (escrow + logic)|                       v
              +----------+-----+                 +-------------+
                         |  approve exact amount |   0x API    |
                         v                       +-------------+
                +----------------+
                | 0x AllowanceHolder (allowlisted swap target)
                +----------------+
                         ^
        price reads      |
              +----------+-----+
              | Chainlink feeds |
              +-----------------+
```

There are four deliberately separate layers:

1. **Contract** (`contracts/ArcTradeOrders.sol`): holds user funds, validates prices, enforces minimum outputs, and decides whether an execution is allowed. It is the only component that can move escrowed funds.
2. **Backend** (`server/`): keeps the 0x API key secret, caches and rate-limits quote traffic, and optionally runs a keeper. It never holds user funds or user keys.
3. **Frontend** (`src/`): reads chain state directly from the RPC, builds transactions, and asks the user's wallet to sign. It talks to the backend only for quotes and status.
4. **Automation**: anything that calls the contract's permissionless execution functions. The built-in keeper is one provider; anyone can run another.

## Trust boundaries

| Component | Can it take user funds? | Notes |
| --- | --- | --- |
| Contract owner | Not directly | Can pause, queue (timelocked) feed and swap-target changes, and lower the keeper fee. Cannot withdraw escrow. A malicious owner could try to queue a hostile feed or target; the delay gives users time to cancel. |
| Keeper | No | Supplies swap calldata. The contract checks balance deltas and a minimum output, so bad calldata just reverts. |
| Backend | No | Never sees keys except the keeper operator's own key. |
| 0x / swap target | Only up to the exact approved amount during one execution | The approval is set for exactly the order's input and reset to zero afterwards. |
| Oracle | Influences trigger and floor | Feed values are checked for freshness and sign. See [oracle-and-pricing.md](oracle-and-pricing.md). |

## Order lifecycle (conditional orders)

1. The user approves the contract for the exact escrow amount and calls `createOrder`. The contract reads the oracle, validates trigger placement against the current price, pulls the funds, and emits `OrderCreated`.
2. A keeper watches the order. When the oracle price satisfies the trigger it fetches a 0x quote with the contract as the taker, then calls `execute(id, target, data)`.
3. The contract re-checks the trigger with its own oracle read, computes a minimum output, approves the swap target for exactly the input, runs the call, resets the approval, verifies the input was fully spent and the net output (after the keeper fee) meets the minimum, then pays the owner and the keeper.
4. If anything fails the whole transaction reverts and the order stays open. The user can cancel at any time, and expired orders can be refunded by anyone.

DCA plans follow the same execution path with a time schedule instead of a price trigger. See [order-types.md](order-types.md).

## Market swaps (no escrow)

Market orders do not use the contract. The browser asks the backend for a 0x firm quote with the user as taker, the user approves the sell token for the exact amount if needed, and the wallet sends the transaction straight to 0x's AllowanceHolder. Market swaps made this way are not recorded onchain by the order contract; the app keeps the transaction hash in the browser's local storage and shows it under Trade history labelled as sent from this browser.

## Why the contract does not use the DEX price

A pool price can be pushed by a single large trade inside one transaction. The contract therefore derives trigger and floor from Chainlink feeds, and treats the aggregator only as a source of routes. Even if the calldata is adversarial, the balance-delta and minimum-output checks decide the outcome. See [security.md](security.md).

## Data flow in the UI

| Data | Source | Refresh |
| --- | --- | --- |
| Balances | `balanceOf` for all tokens in one Multicall3 request | 12 s |
| Orders and DCA plans | `getOrderIds` then batched `getOrder` and `checkOrder` | 8 s |
| Oracle price | `tokenConfigs` and `currentPrice` | 15 s |
| Execution history | `OrderExecuted` / `DcaExecuted` logs, resumed from the last scanned block | 20 s |
| Swap price | Backend `/price`, cached about 4 s | 12 s |
| Chart | Coinbase Exchange REST then WebSocket ticker | live |

## Network matrix

| Capability | Arc Testnet (5042002) | Arc mainnet (5042) |
| --- | --- | --- |
| Order contract | Deployed | Deploy yourself |
| 0x swaps | Not supported by 0x | Supported |
| Chainlink Data Feeds | Not deployed | Supported |
| Conditional orders / DCA | Disabled (no oracle) | Enabled once feeds are configured |

Arc's native gas token is USDC. The app shows one USDC balance from the 6-decimal ERC-20 view; the 18-decimal native view is used only for gas estimates.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/trading/networks.ts` | Per-network config: tokens, contract address, capability flags |
| `src/trading/math.ts` | Pure price and amount math mirrored from the contract |
| `src/trading/hooks.ts` | Chain reads (multicall batched), oracle, logs, health |
| `src/trading/aggregator.ts` | `AggregatorAdapter` interface and the 0x adapter |
| `src/trading/market.ts` | Candles, indicators, live ticker |
| `src/trading/portfolio.ts` | Positions and PnL from contract fills |
| `src/trading/tx.ts` | Chain switch, write, receipt, toasts, error parsing |
| `server/zerox.ts` | Validated 0x client |
| `server/keeper.ts` | Batched, sharded, backoff-aware keeper |
| `server/scale.ts` | Cache, rate limiter, sharding, backoff, metrics |
