# Arc Terminal

A non-custodial trading terminal for Arc: market swaps through a DEX aggregator, escrowed conditional orders (limit, stop-loss, take-profit, stop-limit, trailing stop, OCO), recurring buys (DCA), a wallet portfolio, and a placeholder for a future prompt-driven trading station.

Built with [Arc Studio](https://studio.arc.io)

## Testnet test assets

Arc Testnet has no real oracle or aggregator, so the project ships a clearly labelled test harness: three test tokens (tBTC, tETH, tSOL) with public, settable test price feeds and a test swap router. It lets you try every order type on real contracts. Prices there are not market prices. See [docs/testnet-harness.md](docs/testnet-harness.md).

## Documentation

Full documentation is in [docs/](docs/README.md): architecture, contract reference, order types, oracle and pricing, aggregator, keepers and automation, backend API, frontend, configuration, deployment, scaling, testing, operations, security and limitations.

## What works where

| Feature | Arc Testnet | Arc mainnet |
| --- | --- | --- |
| Wallet, balances, approvals | Yes | Yes |
| Order contract | Deployed | You deploy and review it yourself |
| Market swaps (0x) | Not supported by 0x | Needs a 0x API key |
| Oracle-priced orders and DCA | Disabled: no Chainlink feeds | Needs feeds configured on your contract |
| Charts | Reference data from Coinbase Exchange | Same |

Charts show a centralized-exchange reference price for the underlying asset, not an Arc pool price. The order book panel is replaced by live aggregator quotes at several sizes, because Arc liquidity is AMM-based.

Orders keep funds in the contract. They run when a keeper submits them; there is no managed automation service on Arc today. You can run the built-in keeper or any third party can.

## Tech stack

React, Vite, TypeScript, Tailwind, wagmi, viem, Lightweight Charts, Bun (backend and tests), Solidity with OpenZeppelin and Foundry.

## Development

Prerequisites: Bun, Foundry.

```bash
bun install
bun run dev        # frontend on :5173
bun run server     # backend on :3001 (quote proxy and optional keeper)
bun test           # frontend and backend unit tests
bun run contracts:test
bun run check      # lint and typecheck
```

### Environment variables

| Name | Purpose |
| --- | --- |
| `VITE_ORDERS_ADDRESS_ARC_TESTNET` | Deployed order contract on Arc Testnet |
| `TESTNET_DEPLOYER_PRIVATE_KEY` | Backend scripts only. Throwaway Arc Testnet key for the test harness (`server/testnet/`) |
| `KEEPER_USE_TEST_ROUTER` | Set to `false` to stop the testnet keeper from using the test router |
| `VITE_ORDERS_ADDRESS_ARC_MAINNET` | Order contract you deploy on Arc mainnet |
| `VITE_ORDERS_DEPLOY_TX_ARC_TESTNET`, `VITE_ORDERS_DEPLOY_TX_ARC_MAINNET` | Optional. Deployment transactions, used to start history reads at the right block |
| `ZEROEX_API_KEY` | Backend only. 0x Swap API key for quotes |
| `KEEPER_ENABLED` | Set to `true` to start the built-in keeper |
| `KEEPER_PRIVATE_KEY` | Backend only. Funded key of the keeper operator (pays gas, earns the keeper fee) |
| `KEEPER_NETWORK` | `arc-testnet` (default) or `arc` |
| `KEEPER_INTERVAL_MS` | Keeper poll interval, default 15000 |
| `KEEPER_SHARD_INDEX`, `KEEPER_SHARD_COUNT` | Split keeper work across several instances (default 0 and 1) |
| `KEEPER_MAX_ACTIONS_PER_TICK`, `KEEPER_QUOTE_CONCURRENCY` | Keeper throughput caps (defaults 25 and 4) |
| `PRICE_CACHE_TTL_MS` | How long identical price requests share one upstream call, default 4000 |
| `RATE_LIMIT_SCALE` | Multiplier for per-client rate limits, default 1 |
| `API_PORT` | Backend port, default 3001 |
| `RPC_URL_Arc_Testnet`, `RPC_URL_Arc` | Optional. Your own RPC for the keeper |
| `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` | Optional outside Arc Studio. Provisioned RPC proxy for the backend |

Never commit `.env`. Secrets stay on the backend and are never prefixed with `VITE_`.

## Going to mainnet

Do this only after your own review and an independent audit.

1. Deploy `contracts/ArcTradeOrders.sol` from your own wallet with a configuration delay of 48 hours or more.
2. Queue oracle feeds for each token and the 0x AllowanceHolder as a swap target on the contract, then apply them after the delay.
3. Add the tokens to `src/trading/networks.ts` and set `VITE_ORDERS_ADDRESS_ARC_MAINNET`.
4. Add `ZEROEX_API_KEY` and, if you run a keeper, `KEEPER_NETWORK=arc`.

## Fees

Gas is paid in USDC. Keepers take up to 0.10% of an order's output, set on the contract and only ever lowered. 0x may charge its own fees on swaps.
