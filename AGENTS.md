# Arc Terminal

> Built with Arc Studio - money-powered apps in minutes

Project memory for future agents.

## What This App Does

Non-custodial trading terminal on Arc: 0x market swaps, escrowed conditional orders and DCA via `ArcTradeOrders`, portfolio, and a Prompt Station placeholder (UI only, no LLM).

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind (class dark mode, CSS variable tokens in `src/index.css`)
- Web3: wagmi v2, viem, ConnectKit
- Contracts: Solidity + Foundry in `contracts/`, tests in `contracts/test/` (169 tests)
- Backend: `server/` (Bun). `bun run server`. Vite proxies `/api` to :3001
- Chain: Arc Testnet (5042002) default; Arc mainnet (5042) supported by config

## Deployed contracts

- ArcTradeOrders on Arc Testnet (harness deployment, current): `0x259d5810aadfde23ac193dce84e6462025cea02c`, saved as `VITE_ORDERS_ADDRESS_ARC_TESTNET` and in `src/trading/testnet-harness.json`. The earlier `0x7da5f7d0cf7f5c751dfed545ebf72400c87b724e` (shared platform owner) is superseded and unused.
- No mainnet deployment. Mainnet is deployed and operated by the user.

## Verified Arc facts (researched 2026-11-11)

- 0x Swap API supports Arc mainnet only (not testnet). Needs `ZEROEX_API_KEY` on the backend.
- Chainlink Data Feeds exist on Arc mainnet only; feed list in the chainlink skill reference. Heartbeat 24h, call `decimals()`.
- Gelato Web3 Functions shut down 2026-03-31. Chainlink Automation: no Arc evidence. Execution is permissionless keepers (`server/keeper.ts`).
- USDC is the gas token; show one USDC balance from the 6-decimal ERC-20 view.

## Design decisions

- Trailing-stop peaks and stop-limit activation are only persisted by `pokeTrailing` and `activateStop`; a keeper must call them.
- Execution reverts on failure (no failure counters) so griefers cannot brick orders.
- Owner config changes (feeds, swap targets) are timelocked; disabling is instant; keeper fee can only be lowered.
- Mainnet tokens in `src/trading/networks.ts` are intentionally empty until the user reviews mainnet config.

## Scaling (off-chain only; contract unchanged)

- Keeper keeps an in-memory open set, batches reads with Multicall3, caps actions per tick, backs off failing items, supports id sharding (`server/keeper.ts`, helpers in `server/scale.ts`).
- Backend caches/coalesces `/price`, rate limits per client, exposes `/metrics`.
- Frontend reads use multicall, history logs resume from a stored block, tables paginate.
- Contract-level scaling ideas (batch execute, paged views) need a new audit; see `docs/scaling.md`.
- Docs live in `docs/`; keep them in sync when behaviour changes.

## Key Files

- `contracts/ArcTradeOrders.sol` - escrow, oracle checks, orders, DCA
- `src/trading/` - networks, math, hooks, aggregator adapter, market data, portfolio
- `src/components/` - Terminal, TradePanel, forms, OrderTabs, Portfolio, PromptStation
- `server/` - 0x proxy, keeper, automation provider registry
- `tests/trading.test.ts` - `bun test`
- `ordersAbi.ts` is generated from the Foundry artifact; regenerate after contract changes

## Share links

- Use `buildShareLink` from `src/lib/share.ts` for any link a user copies; keep `installShareSync()` in `src/main.tsx`.
- Never put secrets in URL paths or queries.
