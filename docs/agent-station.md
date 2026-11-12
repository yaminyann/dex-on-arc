# Agent Station

Type a command, read the exact terms back, say yes, and the agent sends it. It covers everything the forms do: market buy and sell, limit, stop-loss, take-profit, stop-limit, trailing stop, OCO, DCA, and cancel, pause and resume.

You can **chat in plain words** ("sell half my bitcoin if it falls to 80k") or type a command. Underneath, every action is **one command of a small fixed grammar** (`src/trading/agent/parser.ts`), and the same text always gives the same result. Understanding your message costs nothing by default:

1. **Strict grammar** (`parser.ts`). Typed commands are read exactly. A common token name is mapped to the listed symbol ("bitcoin" to tBTC).
2. **Built-in chat rules** (`chat.ts`, runs in your browser, no network, no model, no cost). Plain wording is rewritten into a command and shown ("I read that as: stop loss 50% tBTC at 80000"). The rules also answer questions about order types, and suggest setups from what you hold. When a detail is missing (amount, price, duration) they ask for it instead of guessing.
3. **Optional language model** (`server/agent-chat.ts`, off by default). Only if the operator sets `AGENT_LLM_URL` and `AGENT_LLM_MODEL`, wording the rules could not read is sent to an OpenAI-compatible endpoint, for example a local Ollama server (free) or a free-tier hosted model. See below.

Whichever route produced it, the result is the same: one command, a plan built from live data, a readback with exact numbers, your yes, and a wallet signature. Nothing in this chain can skip those steps.

## The flow

1. You type a command. Read-only ones (`help`, `balance`, `orders`, `price tBTC`) answer at once.
2. For an action, the agent builds a **plan from live data**: your real balance, the oracle price, a real quote from the aggregator, the contract's minimum order size. If something does not hold (not enough balance, stop above the price, token has no feed, no route) it says so and stops.
3. It shows the plan: action, amounts, prices, minimum output, slippage, expiry, fees, warnings. It asks **"Is this exactly what you want?"**
4. You answer `yes` (or click **Yes, run it**). `no` or **Cancel** drops it. Typing a new command replaces an unanswered one, so a stray "yes" can only confirm the latest command.
5. It runs the same contract calls as the forms (an exact-amount approval first if needed), then reports the result with transaction links.

A plan older than **one minute** is rebuilt and asked about again, because prices may have moved. A market swap is also re-quoted at send time and refused if the price got more than 0.5% worse than the one you confirmed.

## Chat

Examples the built-in rules understand:

| You write | It reads |
| --- | --- |
| `I want to buy bitcoin for 10 dollars` | `buy 10 USDC of tBTC` |
| `sell half my bitcoin if it falls to 80k` | `stop loss 50% tBTC at 80000` |
| `sell all btc when it reaches 100k` | `take profit all tBTC at 100000` |
| `sell all bitcoin if it drops 10%` | `stop loss all tBTC at <10% below the oracle price>` |
| `buy 5 dollars of bitcoin every day for a week` | `dca 5 USDC into tBTC daily for 7 days` |
| `put a 5% trailing stop on all my btc` | `trailing stop all tBTC 5%` |
| `what is a stop loss?` | an explanation, with an example to edit |
| `what should I do?` | setups based on your holdings, each with its reason |

**Suggestions** come from simple risk rules on what you hold, not from predictions: an OCO (stop 5% below, target 10% above) or a 5% trailing stop for a token with no stop yet, a one-week DCA from half your free USDC, a limit buy 3% below the current price. Each says why, is labelled as not financial advice, and runs only after you tap it, see the exact terms and say yes.

**Missing details are asked for.** "buy bitcoin" asks how much USDC; a DCA without a length asks for one. Prices and amounts are never invented. A percentage move ("if it drops 5%") uses the oracle price shown in the answer.

## Optional language model

Off unless the operator sets these on the backend (see [configuration.md](configuration.md)):

| Variable | Meaning |
| --- | --- |
| `AGENT_LLM_URL` | Base URL of an OpenAI-compatible API, for example `http://localhost:11434/v1` (Ollama, no fee), or the `/v1` URL of a free-tier provider |
| `AGENT_LLM_MODEL` | Model name, for example a small 3B to 8B instruct model |
| `AGENT_LLM_API_KEY` | Only if the endpoint needs one. Stays on the server |
| `AGENT_LLM_DAILY_CALLS` | Global cap per UTC day (default 2000), so a free tier is never exhausted |

What it is allowed to do:

- It receives the one message you typed, the token symbols and the quote currency. **No balances, no address, no history.**
- It may return a short reply and **at most one command**. The command is parsed again on the server and again in the browser by the strict parser; anything that does not parse, contains a line break, a semicolon or a backtick, or is longer than 200 characters is dropped.
- It is told never to invent an amount, price or duration, not to predict prices, and to treat your message as data. Even if it is fooled, the worst result is a command you then read back, and your wallet still signs.
- Per-client rate limit (12 a minute), global daily budget, 12 second timeout, input limited to 300 characters. If the model fails or the budget is used up, the built-in rules keep working.
- The chat tells users when the model is on, and that their message may be sent to it.

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
- Untrusted text never becomes an instruction: only the user's own typing is read, and nothing from a page, token name or quote is executed. Model output is only ever a candidate command for the strict parser.
- Chat rewrites are shown before they are used, and a rewrite that the strict parser rejects is discarded.
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
