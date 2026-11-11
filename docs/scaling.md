# Scaling

This document explains how the system behaves as orders, users and request volume grow, what was changed to make it scale, where the limits are, and what would require a contract change.

Numbers below are design arithmetic, not benchmarks. Measure on your RPC provider and traffic before promising capacity. RPC rate limits are not known to this project and differ by provider.

## Where load comes from

| Source | Grows with | Cost driver |
| --- | --- | --- |
| Keeper reads | Open orders and DCA plans | RPC requests per tick |
| Keeper actions | Triggered orders | Gas, 0x quotes, transactions |
| Browser reads | Connected users and open tabs | RPC requests per user per refresh |
| Quote traffic | Users typing amounts | 0x requests (API quota) |
| History | Executed fills per user | Log range scanned |

## What was done

### Keeper

| Before | Now |
| --- | --- |
| Re-read every order each tick with 2 sequential calls each | Open set kept in memory; reads batched through Multicall3 (about 50 orders, 100 calls, per request) |
| Re-read all ids each tick | Only unseen ids are discovered; closed ids drop out of the set |
| No limit on work per tick | `KEEPER_MAX_ACTIONS_PER_TICK` cap; maintenance first, then executions |
| Quotes fetched one at a time | Bounded parallel quotes (`KEEPER_QUOTE_CONCURRENCY`) |
| A stuck order retried every tick | Per-item exponential backoff (30 s up to 10 min) |
| Single instance | Optional sharding by id (`KEEPER_SHARD_INDEX` / `KEEPER_SHARD_COUNT`) |
| Fixed sleep after each tick | Sleeps the remainder of the interval so slow ticks do not stack |

Approximate steady-state read cost per tick, with N open orders on one instance: `ceil(N / 50)` multicall requests plus 2 for the counters. With 5,000 open orders that is about 100 batched requests per tick instead of 10,000 individual calls.

### Backend

- **Price cache with coalescing**: identical `/price` requests inside 4 s (configurable) cost one upstream call. Under a burst of N users requesting the same pair and size, upstream load is 1 call per TTL window.
- **Rate limiting**: per-client fixed windows (see [backend-api.md](backend-api.md)) protect the 0x quota from a single noisy client.
- **Metrics**: `/metrics` shows cache hit ratio, rate-limited requests, keeper tick duration and queue sizes so you can see saturation.

### Frontend

- All per-user reads use Multicall3: balances in one request; orders in two requests regardless of order count (all orders, then readiness for open ones).
- Execution history resumes from the last scanned block stored in the browser, so each refresh scans a small range rather than the whole history.
- Tables paginate at 25 rows, so large accounts do not render thousands of rows.
- Oracle reads are shared across components through the query cache.

## Horizontal scaling recipes

### More orders than one keeper tick can handle

Run shards:

```
KEEPER_SHARD_COUNT=4 KEEPER_SHARD_INDEX=0 bun run server   # instance A
KEEPER_SHARD_COUNT=4 KEEPER_SHARD_INDEX=1 bun run server   # instance B
...
```

Use one funded key per instance. Each id maps to exactly one shard, so instances never submit the same order. If an instance dies its shard stops until it restarts; add a supervisor, or run an unsharded standby keeper that only acts when it sees stale items (any keeper can execute any order).

### More quote traffic

- Put the backend behind a proxy that sets `x-forwarded-for`.
- Raise `RATE_LIMIT_SCALE` only after confirming your 0x plan's quota.
- For several backend replicas, the in-memory cache is per replica. Put a shared cache (for example Redis) in front if the hit ratio matters; the `TtlCache` interface is small enough to swap.

### More browsers

The browser talks to the RPC directly. Use a dedicated RPC provider with a key for production, or place a caching RPC proxy in front. The public Arc RPC is fine for development.

## Capacity limits that remain

| Limit | Why | Mitigation |
| --- | --- | --- |
| Keeper scans ids linearly | Contract has no index of open orders by trigger price | Sharding; roadmap item below |
| One transaction per execution | Contract has no batch executor | Parallel keepers on different keys; roadmap item below |
| Log scans are per user | Events are filtered by owner but the range grows over time | Browser cache; an indexer (see below) for very active users |
| History in `localStorage` | Browser storage limits | Falls back to rescanning; keep the cache small |
| `getOrderIds(owner)` returns all ids | Unbounded array per owner | Very large accounts should be paged by a contract view (roadmap) |

## Contract-level roadmap (needs a new audit)

The deployed contract is intentionally unchanged by the scaling work, because changing escrow code requires a new security review. These changes would raise capacity further:

1. **Batch execution**: `executeMany(ids[], targets[], data[])` that continues on per-item failure, saving per-transaction overhead for keepers.
2. **Paged views**: `getOrderIds(owner, offset, limit)` and a combined `getOrders(ids[])` view to remove the extra multicalls.
3. **Open-order index**: an onchain or event-derived structure keyed by trigger bucket, so keepers query only orders near the current price.
4. **Event-driven keeper**: subscribe to `OrderCreated` and oracle `AnswerUpdated` events instead of polling.
5. **Optional indexer**: now built off-chain (see [indexer.md](indexer.md)); it serves history without per-user log scans. Use a durable volume or managed Postgres.

## Capacity planning worksheet

1. Decide the maximum open orders N and the target latency L (time from trigger to execution attempt).
2. Pick `KEEPER_INTERVAL_MS` below L. A tick must finish inside the interval: watch `keeper.lastTickMs` in `/metrics`.
3. Estimate reads per tick: `ceil(N / 50) + 2` multicalls. Check them against your RPC provider's limits.
4. Estimate peak triggers per tick T (for example a sharp price move). Actions per tick are capped at `KEEPER_MAX_ACTIONS_PER_TICK`; set it and the shard count so `shards * cap >= T` per interval.
5. Make sure the 0x plan covers `T` quotes per interval plus user price traffic.
6. Fund each keeper key with enough USDC for the gas of a full burst.
