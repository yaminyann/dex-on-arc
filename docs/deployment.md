# Deployment

## Current testnet deployment

| Item | Value |
| --- | --- |
| Network | Arc Testnet (5042002) |
| Contract (current testnet) | v2 at `0xa83efe842010dbd470dfe7cc210d61c4edd908aa` (harness, owner = deployer key, unaudited). See [testnet-harness.md](testnet-harness.md) |
| Contract (superseded) | Superseded: `0x7da5f7d0cf7f5c751dfed545ebf72400c87b724e` (shared owner, cannot register feeds). The current testnet deployment is the harness contract in [testnet-harness.md](testnet-harness.md) |
| Constructor | owner = the shared platform deployer wallet, quote = USDC `0x3600000000000000000000000000000000000000`, configDelay = 3600 s |
| Deployed | 2026-11-11 |

The testnet owner is a shared wallet nobody on a project controls, so owner functions (queueing feeds, allowlisting swap targets, pausing) cannot be called on this deployment. That is fine for testing creation, escrow, cancel and refund flows, but feeds are required before orders can be created, and testnet has none. To test the full lifecycle, deploy your own instance with your own owner and a mock or real feed.

## Constructor

```solidity
constructor(address owner_, address quote_, uint32 configDelay_)
```

| Argument | Rules |
| --- | --- |
| `owner_` | Administrator. Use a multisig on mainnet. Ownership transfer is two-step |
| `quote_` | Quote token, USDC on Arc: `0x3600000000000000000000000000000000000000` |
| `configDelay_` | Between 1 hour and 14 days. Use 48 hours or more on mainnet |

## Before any mainnet deployment

Transactions on mainnet involve real funds and are irreversible. Review everything yourself and get an independent audit first. This repository's reviews and tests are not a substitute for a third-party audit. The tooling that generated this project does not deploy to, sign for, or fund mainnet; you deploy and operate it from your own wallet.

Checklist:

1. Run `bun run contracts:test` and read [security.md](security.md), especially the limitations section.
2. Obtain an independent audit of `contracts/ArcTradeOrders.sol` and the exact compiler settings.
3. Decide the owner (multisig recommended) and the `configDelay`.
4. Decide which tokens and feeds you will support; verify each feed address and decimals against Chainlink's directory.
5. Decide which swap target to allowlist (0x AllowanceHolder). Confirm its address from 0x's documentation for Arc; never copy it from an unverified source.
6. Rehearse the whole procedure on testnet with your own owner.

## Deploy with Foundry

Use Arc's Foundry fork or standard Foundry with Arc's settings. Keep the key in an environment variable and prefer a keystore over a plain-text flag.

```bash
export ARC_RPC_URL=<mainnet RPC from the chain facts, https://rpc.mainnet.arc.io>
cast wallet import deployer --interactive          # encrypted keystore
forge create contracts/ArcTradeOrders.sol:ArcTradeOrders \
  --rpc-url "$ARC_RPC_URL" --account deployer --broadcast \
  --constructor-args <OWNER> 0x3600000000000000000000000000000000000000 172800
```

Arc's base fee has a 20 gwei floor; a transaction priced below it is dropped silently. If a deployment seems to hang, check the fee.

Record the deployment transaction hash and set `VITE_ORDERS_ADDRESS_ARC_MAINNET` and `VITE_ORDERS_DEPLOY_TX_ARC_MAINNET`.

## Configure the contract

All feed and swap-target changes are timelocked.

```text
queueTokenConfig(USDC, <USDC/USD feed proxy>, 90000)    -> changeId   (quote token needs a feed too)
queueTokenConfig(<BASE>, <BASE/USD feed proxy>, 90000)  -> changeId
queueSwapTarget(<0x AllowanceHolder>, true)              -> changeId
... wait configDelay ...
applyConfig(changeId) for each
```

Verify afterwards: `tokenConfigs(token)`, `swapTargets(target)`, `currentPrice(base)` returns a sane price, `keeperFeeBps()` is acceptable.

Emergency tools: `pause()` stops creation and execution but never refunds; `disableToken` and `disableSwapTarget` take effect immediately; `setKeeperFeeBps` can only lower the fee.

## Configure the app

1. Add the mainnet tokens in `src/trading/networks.ts` (address, decimals, optional Coinbase reference product).
2. Set the `VITE_*` addresses and the backend variables in [configuration.md](configuration.md).
3. Start the backend with `ZEROEX_API_KEY`. Optionally start one or more keepers with `KEEPER_NETWORK=arc`.
4. Open the app on Arc mainnet and confirm: oracle price shows in the pair bar, the automation card lists your keeper, a small order can be created and cancelled.

## Hosting the frontend

The frontend is a static Vite build (`bunx vite build`, output in `dist/`). Host it anywhere that serves single-page apps with a fallback to `index.html`. The backend is a separate Bun process; the frontend expects it at `/api` (use your host's rewrite or reverse proxy to forward `/api/*` to it, stripping the prefix). Do not expose `ZEROEX_API_KEY` or keeper keys through `VITE_` variables or to the browser.

## Upgrades

The contract is not upgradeable. A new version means a new deployment: pause the old one, let users cancel or let orders fill, and point the app at the new address. Keeping the old address in the app's history view is a good idea until users have exited.
