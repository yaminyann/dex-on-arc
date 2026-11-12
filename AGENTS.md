# Arcora (repository: Arc Terminal)

> Built with Arc Studio - money-powered apps in minutes

Project memory for future agents.

## What This App Does

Non-custodial trading terminal on Arc: market swaps through a quote gateway (0x, KyberSwap; test routers on testnet), escrowed conditional orders and DCA via `ArcTradeOrders`, and a portfolio page.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind (class dark mode, CSS variable tokens in `src/index.css`)
- Web3: wagmi v2, viem, ConnectKit
- Contracts: Solidity + Foundry in `contracts/`, tests in `contracts/test/` (191 tests, run with Foundry v1.7.1)
- Backend: `server/` (Bun). `bun run server`. Vite proxies `/api` to :3001. Quote gateway in `server/gateway/`, event indexer in `server/indexer/` (SQLite or Postgres via Bun SQL)
- Chain: Arc Testnet (5042002) default; Arc mainnet (5042) supported by config

## Deployed contracts

- ArcTradeOrders **v2** on Arc Testnet (current, unaudited): `0xa83efe842010dbd470dfe7cc210d61c4edd908aa`, saved as `VITE_ORDERS_ADDRESS_ARC_TESTNET` and in `src/trading/testnet-harness.json`. Superseded: v1 harness `0x259d5810aadfde23ac193dce84e6462025cea02c` (kept as `ordersV1`) and `0x7da5f7d0cf7f5c751dfed545ebf72400c87b724e` (shared platform owner).
- v2 adds: owner-set minimum order size, expiring queued config, rich `ConfigQueued`, oracle round check, paged views, `executeMany`, no `renounceOwnership`. Runtime size is 23,778 B of the 24,576 B limit: run `forge build --sizes` before adding code.
- No mainnet deployment. Mainnet is deployed and operated by the user.

## Verified Arc facts (researched 2026-11-11)

- 0x Swap API supports Arc mainnet only (not testnet). Needs `ZEROEX_API_KEY` on the backend. KyberSwap (`aggregator-api.kyberswap.com/arc`, keyless) is live on Arc mainnet (verified 2026-11-12); its router is `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`. Neither exists on Arc Testnet, so testnet swaps use the test routers.
- Arc emits a `Transfer` log for the native gas fee from `0xfffffffffffffffffffffffffffffffffffffffe`; ignore it when deriving swaps from receipts.
- Stock anvil cannot execute Arc USDC transfers (native precompile); a mainnet fork needs Arc's Foundry fork.
- Foundry v1.7.1 is at `~/.foundry-v1.7.1` on the dev machine, bun at `~/.bun/bin` (the PATH `bun` shim is broken).
- Chainlink Data Feeds exist on Arc mainnet only; feed list in the chainlink skill reference. Heartbeat 24h, call `decimals()`.
- Gelato Web3 Functions shut down 2026-03-31. Chainlink Automation: no Arc evidence. Execution is permissionless keepers (`server/keeper.ts`).
- USDC is the gas token; show one USDC balance from the 6-decimal ERC-20 view.

## Design decisions

- Trailing-stop peaks and stop-limit activation are only persisted by `pokeTrailing` and `activateStop`; a keeper must call them.
- Execution reverts on failure (no failure counters) so griefers cannot brick orders.
- Owner config changes (feeds, swap targets) are timelocked; disabling is instant; keeper fee can only be lowered.
- Mainnet `bases` in `src/trading/networks.ts` stay empty on purpose: the picker loads ~60 aggregator-routable tokens from `/api/tokens` (KyberSwap registry, filtered). Market swaps work for all; orders need an oracle feed on the contract.
- Platform fee: market swaps only, via the aggregator's own fee params (`PLATFORM_FEE_BPS` max 100, `PLATFORM_FEE_RECIPIENT`); invalid settings turn it off. Order revenue is the keeper fee (lower-only). No contract change.
- Brand lives in `src/brand.ts` (name Arcora, tagline, links from `VITE_SOCIAL_*`/`VITE_*_URL`; never invent social handles). Pages: Trade, Dashboard (was Portfolio), Lending (design only: dashes, no invented rates), Agent, Admin.
- Agent Station (`src/trading/agent/`, `src/components/AgentStation.tsx`) is a deterministic command parser, not an LLM: it builds a plan from live data, reads it back, waits for yes, then runs the form calls. One-time permission with limits and scopes in `agent-permission.ts`; the wallet still signs every tx. See `docs/agent-station.md`.
- Settings (`src/trading/settings.tsx`) are sanitised on load and applied live (theme, accent, size, slippage, expiry, defaults, agent grant). Key `arcora-settings-v2`.
- Admin page (`src/components/Admin.tsx`) is shown to the contract owner only; owner log comes from `/admin-events` (needs the indexer).
- Deploy: `Dockerfile` (targets web, api), `docker-compose.yml`, `deploy/nginx.conf`, `scripts/coolify/{gen-env,preflight}.ts`. One api container only (keeper + indexer hold state).

## Scaling (off-chain only; contract unchanged)

- Keeper keeps an in-memory open set, batches reads with Multicall3, caps actions per tick, backs off failing items, supports id sharding (`server/keeper.ts`, helpers in `server/scale.ts`).
- Backend caches/coalesces `/price` per pair (not per wallet), rate limits per client (`x-forwarded-for` ignored unless `TRUSTED_PROXY_HOPS`), exposes `/metrics` (operator only, Prometheus format available) and sends webhook alerts.
- Keeper: gateway quotes, profit gate, explicit nonces, standby role, WebSocket wake (`KEEPER_WS_URL`).
- Frontend reads use multicall, history logs resume from a stored block, tables paginate.
- Contract-level scaling ideas (batch execute, paged views) need a new audit; see `docs/scaling.md`.
- Docs live in `docs/`; keep them in sync when behaviour changes.

## Key Files

- `contracts/ArcTradeOrders.sol` - escrow, oracle checks, orders, DCA
- `src/trading/` - networks, math, hooks, aggregator adapter, market data, portfolio
- `src/components/` - Terminal, TradePanel, forms, OrderTabs, Portfolio, NetworkBanner, TestnetTools
- `server/` - quote gateway (`gateway/`), keeper (`keeper.ts`, `keeper-core.ts`), indexer (`indexer/`), alerts, automation provider registry
- `scripts/load-test.ts`, `scripts/fork-mainnet-test.ts` - load test and mainnet-fork test
- `.env.example` lists every setting; `docs/indexer.md` describes the history API
- `tests/*.test.ts` - `bun test` (trading, gateway, indexer, backend integration)
- `ordersAbi.ts` is generated from the Foundry artifact; regenerate after contract changes

## Share links

- Use `buildShareLink` from `src/lib/share.ts` for any link a user copies; keep `installShareSync()` in `src/main.tsx`.
- Never put secrets in URL paths or queries.
