# Frontend

React 18, Vite, TypeScript, Tailwind, wagmi v2 with ConnectKit (injected wallets), viem, TanStack Query, Lightweight Charts, lucide icons.

## Pages

| Page | Component | Contents |
| --- | --- | --- |
| Trade | `Terminal` | Network banner, token selector and pair stats, chart, order tabs, trade panel, swap depth, automation status |
| Portfolio | `Portfolio` | Total value, realized and unrealized PnL, balances with locked funds, DCA performance |
| Prompt Station | `PromptStation` | Disabled coming-soon layout, no model calls |

Navigation, network selector, wallet button, USDC balance, theme toggle and settings live in `Header`.

## Trade panel

`TradePanel` chooses the order type and side. Stops are sell-only and DCA is buy-only, so the side is derived from the type.

| Type | Form | Needs |
| --- | --- | --- |
| Market | `MarketForm` | 0x supported on the network, API key, backend running |
| Limit, Stop-loss, Take-profit, Stop-limit, Trailing stop, OCO | `ConditionalForm` | Contract address, oracle feed for the token |
| DCA | `DcaForm` | Contract address, oracle feed |

If a requirement is missing the panel shows a specific notice instead of a disabled form. Validation mirrors the contract (for example stop price must be below the current oracle price) so users see errors before signing.

Every create flow goes through `ConfirmModal`: summary rows, warnings, and real step progress (approve exact amount if needed, then create). Steps reflect actual wallet and receipt states, never timers.

## Order tabs

Open orders, Order history, Trade history, Positions, DCA strategies, Stop-loss / Take-profit, Failed / expired. Tabs read the same cached queries. Tables paginate at 25 rows. Actions: cancel, refund expired, pause/resume/cancel DCA.

Failed / expired shows expired orders plus a note when orders are triggered but not yet filled (waiting on a keeper or an unfavourable market). The contract intentionally has no failure counter, so there is no "failed attempts" list.

## Data layer (`src/trading`)

| File | Purpose |
| --- | --- |
| `networks.ts` | Network config and token lists, reads contract addresses from `VITE_*` |
| `hooks.ts` | `useOracle`, `useOraclePrices`, `useBalances`, `useAllowance`, `useOrders`, `useDcas`, `useExecutionLogs`, `useBackendHealth`, `useNowSeconds` |
| `tx.ts` | `useTx`: ensure the wallet is on the right chain, send, wait for receipt, toast, parse errors |
| `aggregator.ts` | Aggregator adapter, 0x adapter, backend health fetch |
| `market.ts` | Coinbase candles (paged), 4h and 1W aggregation, SMA/EMA, live ticker |
| `math.ts` | Price and amount math mirrored from the contract |
| `portfolio.ts` | Positions and PnL from executed orders and DCA totals |
| `localTrades.ts` | Market swaps sent from this browser |
| `settings.tsx` | Theme, slippage, expiry, network, page (persisted in local storage) |

All reads that touch many contracts use Multicall3. Query keys include the network and owner, so switching networks never shows another network's data.

## Charts

Real data only. Candles come from Coinbase Exchange (`BTC-USD`, `ETH-USD`, `EURC-USDC`), with a WebSocket ticker moving the latest candle. Coinbase lacks 4h and 1W granularity, so those are aggregated from 1h and 1D candles (weeks start Monday 00:00 UTC). If a request fails the chart shows an error and no candles. The footer always states the data is a reference price, not an Arc pool price. Indicators: volume, MA 20, EMA 50.

## Portfolio and PnL

PnL covers only fills made through the order contract:

- Average entry = total quote spent / total base bought.
- Realized PnL = proceeds from sells minus average cost of the sold quantity.
- Unrealized PnL = remaining quantity at the current oracle price minus its cost.
- Tokens without an oracle price are listed as "No oracle price" and excluded from total value.

Keeper fees per fill come from execution logs. Wallet swaps made elsewhere are not counted, and the UI says so.

## Design system

Arc Dark by default (trading), with a light theme. Colors are CSS variables in `src/index.css` mapped to Tailwind tokens (`canvas`, `panel`, `raised`, `line`, `ink`, `mute`, `accent`, `up`, `down`, `warn`). Fonts: Space Grotesk (display), DM Sans (UI), JetBrains Mono (reserved for hashes). Numbers use tabular figures. Green and red are used only for direction. Motion respects `prefers-reduced-motion`.

## Accessibility and responsiveness

- Tap targets are at least 30 to 44 px; primary actions are 40 px or taller.
- Tab lists use `role="tablist"` / `tab` / `aria-selected`; modals trap Escape and use `role="dialog"`.
- Layout is two columns on large screens and a single column on tablet and mobile; tables scroll horizontally.

## Extending

- **New token**: add it to `networks.ts` and queue its feed on the contract.
- **New order field**: update `ordersAbi.ts` (regenerate from the build artifact), `types.ts`, the form, and `math.ts` previews, then add a test.
- **New aggregator**: see [aggregator.md](aggregator.md).
- **Regenerating the ABI**: after any contract change, rebuild and regenerate `src/trading/ordersAbi.ts` from `contracts/out/ArcTradeOrders.sol/ArcTradeOrders.json`.
