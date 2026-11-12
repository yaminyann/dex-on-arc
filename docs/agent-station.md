# Agent Station

Type a command, read the exact terms back, say yes, and the agent sends it. It covers everything the forms do: market buy and sell, limit, stop-loss, take-profit, stop-limit, trailing stop, OCO, DCA, and cancel, pause and resume.

It is a **command interpreter, not a chat model**. A small fixed grammar turns text into a structured action (`src/trading/agent/parser.ts`). The same text always gives the same result, and anything it cannot read is refused with an example instead of being guessed. No model provider, API key or network call is involved in understanding a command.

## The flow

1. You type a command. Read-only ones (`help`, `balance`, `orders`, `price tBTC`) answer at once.
2. For an action, the agent builds a **plan from live data**: your real balance, the oracle price, a real quote from the aggregator, the contract's minimum order size. If something does not hold (not enough balance, stop above the price, token has no feed, no route) it says so and stops.
3. It shows the plan: action, amounts, prices, minimum output, slippage, expiry, fees, warnings. It asks **"Is this exactly what you want?"**
4. You answer `yes` (or click **Yes, run it**). `no` or **Cancel** drops it. Typing a new command replaces an unanswered one, so a stray "yes" can only confirm the latest command.
5. It runs the same contract calls as the forms (an exact-amount approval first if needed), then reports the result with transaction links.

A plan older than **one minute** is rebuilt and asked about again, because prices may have moved. A market swap is also re-quoted at send time and refused if the price got more than 0.5% worse than the one you confirmed.

## Commands

| What | Example |
| --- | --- |
| Market buy (USDC to spend) | `buy 10 USDC of tBTC` · `buy tBTC with 10 usdc` · `buy $10 of tBTC` |
| Market sell | `sell 0.001 tBTC` · `sell 50% of tBTC` · `sell half tBTC` · `sell all tBTC` |
| Limit | `limit buy tBTC 5 USDC at 70000` · `limit sell 0.001 tBTC @ 95000` |
| Stop-loss | `stop loss 0.001 tBTC at 80000` · `sl 25% tBTC at 80000` |
| Take-profit | `take profit 0.001 tBTC at 100000` · `tp all tBTC at 100000` |
| Stop-limit | `stop limit 0.001 tBTC stop 80000 limit 79000` |
| Trailing stop | `trailing stop 0.001 tBTC 5%` |
| OCO | `oco 0.001 tBTC sl 80000 tp 100000` |
| DCA | `dca 1 USDC into tBTC daily for 7 days` · add `cap 90000` · frequencies hourly, daily, weekly, monthly |
| Manage | `cancel order 12` · `pause dca 3` · `resume dca 3` · `cancel dca 3` |
| Look up | `help` · `balance` · `orders` · `price tBTC` |

Tokens are matched by symbol from the network's tradable list, or by contract address. If two tokens share a symbol the agent lists their addresses and asks you to use one. A market **buy** needs the USDC to spend so the result is exact; sells take an amount, a percentage or `all`.

## Permission: granted once

The first action asks for a one-time permission (inline in the chat, or from the panel on the right). You choose:

- **How long**: this tab (12 hours at most), 1 hour, 24 hours, 7 days, or until you revoke it.
- **Before each command runs**:
  - *Ask "is this exact?"* (default): every command is read back and waits for your yes.
  - *Run inside limits*: a command that fits the limits runs right after the readback. A command over the limits, or one whose size cannot be priced, still waits for your yes.
- **Limits**: largest single command and largest total per day, in USDC.
- **Scopes**: market swaps, orders (limit, stops, trailing, OCO), DCA, and cancel/pause/resume. Each can be switched off.

After that, commands inside the permission do not ask for permission again. The panel shows what is granted, until when, and how much of today's limit is used. **Revoke** ends it at once. The permission and the daily total are stored in this browser only.

### What the permission does not do

- It never holds or sees your keys. **Your wallet still asks you to approve every transaction**, including approvals. The agent cannot bypass that; a wallet that supports session keys is the way to reduce prompts, and that is not built here.
- It does not make the contract safer. The contract is unaudited and the usual order risks apply (oracle lag, no guarantee of a fill, keeper needed).
- The daily total counts the value of commands you approved (escrowed amounts for orders and DCA), not net spending: a cancelled order does not give its amount back to today's total.

## Safety properties

- The plan the user reads is built from the same numbers the transaction uses.
- Every action passes the same checks as the forms: balance, oracle freshness and direction of stops, minimum order size, DCA length (520 buys at most), allowance.
- Limits and scopes are checked before the readback, so an over-limit command never reaches a confirmation.
- Untrusted text never becomes an instruction: only the user's own typing is parsed, and nothing read from a page, token name or quote is executed.
- Messages are kept in memory for the open tab and are not saved.

## Code map

| File | Role |
| --- | --- |
| `src/trading/agent/parser.ts` | Text to intent. Pure, covered by `tests/agent.test.ts` |
| `src/trading/agent/engine.ts` | Intent to plan (validation, quotes, oracle) and plan to transactions |
| `src/trading/agent-permission.ts` | Grant, limits, scopes, daily usage, the gate. Pure, tested |
| `src/components/AgentStation.tsx` | Chat, confirmation cards, permission panel |

## Extending it

Add a phrase to `parser.ts` and a test, add the intent to `engine.ts` (`buildPlan` for actions, `answer` for lookups), and give the plan a `scope`. A model could later propose commands as plain text for the same parser, so it could never bypass the readback, the limits or the wallet.
