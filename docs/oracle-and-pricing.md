# Oracle and pricing

The contract prices every pair from Chainlink Data Feed proxies it reads itself. The DEX price is never used for triggers or floors.

## Availability on Arc (researched 2026-11-11)

| Network | Chainlink Data Feeds |
| --- | --- |
| Arc mainnet (5042) | Yes, about 30 feeds including USDC/USD, EURC/USD, BTC/USD, ETH/USD, many FX pairs |
| Arc Testnet (5042002) | Not deployed |

So on testnet the contract cannot price anything and the UI disables oracle-based orders with an explanation. Feed addresses are not hardcoded in the contract; the owner configures them. For the current list use Chainlink's Reference Data Directory and confirm each feed onchain (`description()`, `decimals()`) before queuing it.

## How a price is built

For each token the contract stores a `TokenConfig`: feed address, feed decimals, token decimals and `maxStaleness`.

1. **Read** `latestRoundData()` on the feed.
2. **Validate**: the answer must be positive; `updatedAt` must be nonzero, not in the future, and no older than `maxStaleness`. Otherwise the call reverts with `InvalidPrice` or `StalePrice`.
3. **Scale** the answer to 18 decimals: multiplied by `10^(18 - feedDecimals)` or divided when the feed has more than 18 decimals. Overflow is checked.
4. **Combine**: the pair price is `baseUsd18 * 1e18 / quoteUsd18`, so the quote token (USDC) must also have a feed. This means a USDC depeg is reflected in the price instead of being assumed away.
5. The reported timestamp is the older of the two feeds.

Result: `price18` is quote-token units per one whole base token, scaled by 1e18. A BTC price of 60,000 USDC is `60000e18`.

## Converting amounts

Amounts are always in smallest units of each token. With base decimals `bd`, quote decimals `qd`:

```
quote out = baseAmount * price18 * 10^qd / (10^bd * 1e18)
base out  = quoteAmount * 1e18 * 10^bd / (price18 * 10^qd)
```

Both round down, use full-precision multiplication, and are fuzz-tested for overflow and round-trip safety. The frontend mirrors the same math in `src/trading/math.ts` so previews match what the contract will compute.

Example: 0.5 BTC (8 decimals) at 60,000 USDC (6 decimals): `50_000_000 * 60000e18 * 10^6 / (10^8 * 1e18) = 30_000_000_000`, which is 30,000 USDC.

## Staleness: choose it deliberately

Arc mainnet feeds use a 24-hour heartbeat and roughly 0.5% deviation threshold (stablecoin and FX feeds differ). That has two consequences:

- A copied "reject if older than 1 hour" rule would reject healthy feeds. A sensible `maxStaleness` is slightly above the heartbeat (for example 90,000 s for a 24 h heartbeat).
- A long staleness window means the price used can lag the real market by up to the deviation threshold between updates, plus whatever moved since the last update. Orders that trigger on that price follow it, and the slippage floor is computed from the same price. Keep slippage tight for volatile assets and prefer feeds with shorter effective update intervals.

Allowed `maxStaleness` range in the contract: 60 s to 172,800 s (2 days).

## Why there is no onchain TWAP

Chainlink feeds are already aggregated across many sources and are not manipulable by a single transaction on Arc, which is the property a TWAP provides against a spot pool price. The contract does not read pools at all. If you add a non-Chainlink feed, make sure it has equivalent manipulation resistance and the same `latestRoundData` shape.

## Decimals gotchas

- Feeds are not uniformly 8 decimals: some are 6, 18 or 0 (exchange-rate and counter feeds). The contract reads and stores `decimals()` when a config is applied.
- Exchange-rate and reserve feeds are not prices. Do not register `cirBTC Reserves` as if it were a USD price.
- cirBTC has no feed of its own in the Arc list. If you price it with BTC/USD you are assuming 1:1 backing; decide that consciously.
- USDC on Arc has an 18-decimal native view and a 6-decimal ERC-20 view of the same balance. The contract and the app use the ERC-20 view only.

## Unsupported pairs

If the base token has no feed the contract reverts with `TokenNotSupported`. The UI reads `tokenConfigs` first and shows "No oracle feed for TOKEN" instead of attempting an order.

## Changing feeds safely

Feed changes are timelocked (see [contract-reference.md](contract-reference.md)). Recommended procedure:

1. Verify the proxy address in Chainlink's directory and by calling `description()` and `decimals()`.
2. `queueTokenConfig(token, feed, maxStaleness)`; record the `changeId` from `ConfigQueued`.
3. Announce the change to users. They can cancel and withdraw during the delay.
4. After the delay, `applyConfig(changeId)`.

Disabling a token is immediate (`disableToken`) because it only reduces attack surface.
