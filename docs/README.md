# Arc Terminal documentation

Arc Terminal is a non-custodial trading terminal for Arc. Users swap through a DEX aggregator, place escrowed conditional orders (limit, stop-loss, take-profit, stop-limit, trailing stop, OCO), and run recurring buys (DCA). Funds stay in a smart contract the user can always exit; anyone can execute an order once its condition is met.

Documentation last verified against the code on 2026-11-11. Facts about third-party networks (0x, Chainlink, Gelato) were researched on that date and can change: re-check them before relying on them.

## Read this first

| If you want to... | Read |
| --- | --- |
| Understand how the pieces fit | [architecture.md](architecture.md) |
| Know exactly what works on testnet vs mainnet | [limitations.md](limitations.md) |
| Set up and run the project | [configuration.md](configuration.md), then [operations.md](operations.md) |
| Deploy the contract, especially to mainnet | [deployment.md](deployment.md) |

## Contract

| Doc | Contents |
| --- | --- |
| [contract-reference.md](contract-reference.md) | Every function, event, error, struct and the swap-execution algorithm |
| [order-types.md](order-types.md) | Each order type with triggers, minimum-output rules and worked examples |
| [oracle-and-pricing.md](oracle-and-pricing.md) | Price feeds, staleness, decimals, and why the contract does not trust the DEX price |
| [security.md](security.md) | Trust model, threat table, review history, known limitations |

## Off-chain system

| Doc | Contents |
| --- | --- |
| [aggregator.md](aggregator.md) | 0x integration, the adapter interface, how to add another provider |
| [automation-and-keepers.md](automation-and-keepers.md) | Who executes orders, the built-in keeper, running third-party keepers |
| [backend-api.md](backend-api.md) | HTTP endpoints, caching, rate limits, error codes |
| [frontend.md](frontend.md) | Pages, components, data flow, state and theming |
| [scaling.md](scaling.md) | How the off-chain stack scales, limits, and the contract-level roadmap |

## Quality and operations

| Doc | Contents |
| --- | --- |
| [testing.md](testing.md) | Contract and application test suites and how to run them |
| [testnet-harness.md](testnet-harness.md) | Test assets, test price feeds and test router for trying every order type on Arc Testnet, plus the live end-to-end test |
| [operations.md](operations.md) | Runbook: start, monitor, troubleshoot, rotate keys |
| [glossary.md](glossary.md) | Terms used across the docs |

## Repository map

```
contracts/ArcTradeOrders.sol   escrow, oracle checks, orders, DCA
contracts/test/                Foundry tests, mocks, invariants
server/                        Bun backend: 0x proxy, keeper, scaling helpers
src/trading/                   networks, math, hooks, aggregator adapter, market data
src/components/                React UI
tests/trading.test.ts          Bun unit tests
docs/                          this folder
```
