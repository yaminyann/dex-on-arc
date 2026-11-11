# Aggregator integration (0x)

## Support on Arc

0x lists Arc mainnet (chain ID 5042) for its Swap API. Arc Testnet is not a supported chain. The project uses the **AllowanceHolder** endpoints (`/swap/allowance-holder/price` and `/quote`, header `0x-version: v2`), which need a 0x API key. Arc has no wrapped native token: USDC is both the gas token and an ERC-20, and swap amounts use the 6-decimal ERC-20 view.

An aggregator does not create liquidity. If no source has a route the app shows "no route has liquidity" and no estimate.

## Two ways a swap executes

| Flow | Taker | Who signs | Where |
| --- | --- | --- | --- |
| Market order | The user | The user's wallet | Browser to `/api/quote`, then the wallet sends `transaction` to AllowanceHolder |
| Conditional order / DCA | The order contract | Nobody at execution time; a keeper submits `execute` | Keeper to `/quote` with `taker = contract`, then `execute(id, transaction.to, transaction.data)` |

## Market order sequence

1. User enters an amount. The browser asks `/api/price` (cached about 4 s) and shows buy amount, minimum received, route, network fee and the difference versus the contract oracle price.
2. On confirm, the browser requests a fresh firm quote from `/api/quote`.
3. If `issues.allowance` shows insufficient allowance, the user approves exactly the sell amount to the reported spender.
4. The wallet sends the transaction to `transaction.to` with `transaction.data` and value 0.
5. The hash is stored locally and shown under Trade history after the receipt confirms.

Quotes are short-lived. If the market moves, `minBuyAmount` (from your slippage setting) is what protects you onchain.

## Conditional execution and why the calldata is untrusted

The keeper passes 0x's calldata to the contract, but the contract never trusts it:

- The target must be allowlisted by the owner (after the config delay). Only allowlist 0x's AllowanceHolder.
- The contract approves the swap target for exactly the order input and resets the approval to zero afterwards.
- It measures balances before and after: the full input must be spent, and the net output (after the keeper fee) must be at least the contract's own minimum computed from the oracle price and the user's limit.
- Anything else reverts and the order stays open.

## The adapter interface

`src/trading/aggregator.ts` defines the seam between UI and provider:

```ts
interface AggregatorAdapter {
  id: string
  name: string
  unavailableReason(): string | null          // why swaps cannot work on this network, if so
  price(req: SwapQuoteRequest): Promise<SwapQuote | null>   // indicative
  quote(req: SwapQuoteRequest): Promise<SwapQuote | null>   // firm, includes transaction
}
```

A `null` result means no liquidity. Errors are thrown as `AggregatorError` with a code. `getAggregator(network)` returns the adapter used by the forms and the depth panel.

### Adding another provider

1. Create a class implementing `AggregatorAdapter`. Normalise the provider response to `SwapQuote` (amounts as `bigint`, `allowanceSpender`, optional `transaction`).
2. Keep any API key on the backend. Add a validated route in `server/` that proxies the provider, mirroring `server/zerox.ts` (strict parameter validation, no key in responses).
3. Return it from `getAggregator` for the networks it supports and set `unavailableReason` for the others.
4. Allowlist the provider's swap target on the contract (queue, wait for the delay, apply). The keeper checks `swapTargets(target)` before sending.
5. Add unit tests for response parsing like the 0x tests in `tests/trading.test.ts`.

## Swap depth panel

Because Arc liquidity is AMM-based there is no order book. The depth panel requests indicative prices for buying with 100, 1,000 and 10,000 USDC and shows the average price and the impact relative to the smallest size. It needs a connected wallet (0x requires a taker), a configured API key and a supported network.

## Fees

0x can charge integrator fees if you configure them; this project does not. The keeper fee (up to 0.10% of output) is separate and enforced by the contract.

## Failure modes

| Symptom | Cause | Behaviour |
| --- | --- | --- |
| "0x API key missing" | `ZEROEX_API_KEY` unset | Quote forms show a notice; no estimate |
| "Quote service offline" | Backend not running | Notice with the start command |
| `CHAIN_NOT_SUPPORTED` | Arc Testnet selected | Market tab shows why swaps are unavailable |
| "No route has liquidity" | Size too large or pair unsupported | No estimate shown |
| 429 | Too many requests from this client | Retry after the `retry-after` seconds |
