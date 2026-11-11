# Limitations and support matrix

An honest list of what does not work, and why. If a control is visible in the app it either works or says why it cannot.

## Network support (researched 2026-11-11)

| Capability | Arc Testnet | Arc mainnet |
| --- | --- | --- |
| Wallet connection, balances, approvals | Works | Works |
| Order contract | Deployed (shared owner) | You deploy |
| Creating orders and DCA | Blocked: no oracle feeds | Works after feeds are configured |
| 0x market swaps and keeper swaps | Not supported by 0x | Works with an API key |
| Chainlink Data Feeds | Not deployed | Available |
| Automation services | Chainlink CRE may exist per tenant; no adapter | Chainlink Automation: no evidence; Gelato Web3 Functions: shut down |
| Charts | Reference data | Reference data |

## Product limitations

| Area | Limitation |
| --- | --- |
| Order book | None. Arc liquidity is AMM-based; the app shows swap depth from live quotes |
| Chart prices | Coinbase Exchange reference prices for the underlying asset, not Arc pool prices. EURC uses EURC-USDC; cirBTC is charted as BTC-USD |
| Market swap history | Not recorded by the contract. Only swaps sent from this browser are listed |
| PnL and positions | Only fills made through the order contract |
| Sell-side only | Stop-loss, take-profit, stop-limit, trailing stop and OCO are sell orders. Buy-side stops are not implemented. Limit supports buy and sell, DCA is buy only |
| Partial fills | Not supported. An execution must spend the entire input or revert |
| Trailing stop and stop-limit | Need a keeper to persist peaks and activation; without one they can trigger late or not at all |
| Execution guarantee | A triggered order is not guaranteed to fill. If the market is worse than the user's minimum it stays open until expiry |
| Failed-attempt log | Not kept onchain by design (a failure counter would let anyone brick an order). The Failed tab lists expired orders and orders waiting for a keeper |
| Wallets | Injected wallets only; no WalletConnect or smart-account flows |
| Prompt Station | UI only. No model provider, key storage or execution |
| Languages and currencies | English UI; amounts in USDC and the listed tokens |

## Contract limitations

See [security.md](security.md) for the complete list. In short: owner-controlled feeds and swap targets (timelocked, not eliminated), no batch execution, no user-selected swap target per order, owner could allowlist a harmful target after the delay, `renounceOwnership` is enabled, pending configs never expire and are not self-describing onchain, oracle round metadata is not checked, and DCA price cap compares the oracle price, not the realized swap price.

## Cost notes

- Gas on Arc is paid in USDC at predictable low fees; the base fee has a 20 gwei floor.
- Keeper fee up to 0.10% of output, lowered by the owner only.
- 0x pricing and quotas depend on your plan; confirm current terms with 0x.
- Automation has no per-task fee in this design. Costs are the keeper's gas and infrastructure, recouped by keeper fees.

## What this project is not

It is not audited by a third party, not formally verified, and not a custody product. The included review and test suite reduce risk but do not remove it. Do not deposit funds you cannot afford to lose, and do not use on mainnet before an independent audit.
