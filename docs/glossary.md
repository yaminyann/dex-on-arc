# Glossary

| Term | Meaning |
| --- | --- |
| Aggregator | A service that finds the best swap route across many DEXs (0x here). It routes liquidity; it does not create it |
| AllowanceHolder | 0x's contract that pulls an approved token amount during a swap. The contract allowlists it as the swap target |
| AMM | Automated market maker: liquidity pools priced by a formula, with no order book |
| Base token | The asset being traded (EURC, cirBTC, WETH) |
| Basis point (bps) | 1/100 of a percent. 50 bps = 0.5% |
| Chainlink Data Feed | An onchain price oracle aggregated from many sources |
| Config delay | Minimum wait between queueing and applying a feed or swap-target change |
| DCA | Dollar-cost averaging: recurring fixed-size buys |
| Escrow | Funds held by the contract for an open order until it fills, is cancelled or expires |
| Heartbeat | Maximum time between oracle updates even if the price does not move |
| Keeper | Any address that submits executions for triggered orders and earns the keeper fee |
| Keeper fee | Share of swap output (up to 0.10%) paid to the executing keeper |
| Limit price | The price an order must beat. For stop-limit, the worst acceptable fill |
| Multicall3 | A contract that batches many read calls into one RPC request |
| Native USDC | USDC viewed as Arc's 18-decimal gas balance. The app uses the 6-decimal ERC-20 view for amounts |
| OCO | One cancels other: a stop-loss and take-profit sharing one escrow |
| Oracle floor | Minimum output computed from the oracle price and the order's slippage |
| price18 | Quote units per one whole base token, scaled by 1e18 |
| Quote token | The pricing asset, USDC |
| Shard | A slice of order ids handled by one keeper instance (`id % count`) |
| Slippage | Allowed difference between expected and received output |
| Stale price | An oracle value older than the configured `maxStaleness` |
| Stop-limit | A stop that, once crossed, becomes a limit order. Not guaranteed to fill |
| Taker | The address holding the sell token in a 0x swap (the user for market orders, the contract for conditional orders) |
| Timelock | The mandatory delay before sensitive configuration takes effect |
| Trailing stop | A stop that follows the highest price seen by a fixed percentage |
| TTL cache | A cache whose entries expire after a fixed time |
| Zid | 0x's request identifier, useful when contacting support |
