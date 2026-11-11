# Indexer and history API

The backend can index the order contract's events into a database and serve history from it, so the browser no longer has to scan logs per user and market swaps are no longer stuck in one browser's local storage.

It is optional and off by default (`INDEXER_ENABLED=true` to start it). Nothing else depends on it: orders, quotes and the keeper work without it, and the frontend falls back to reading logs itself.

## What it stores

| Table | Content |
| --- | --- |
| `events` | Every event the order contract emits (`OrderCreated`, `OrderExecuted`, `DcaExecuted`, `ConfigQueued`, ...), with chain, block, block time, transaction hash, log index, `owner` and `item_id` columns for lookups, and the decoded arguments as JSON. Large numbers are stored as decimal strings so nothing is lost |
| `swaps` | Market swaps reported by browsers and verified against the chain (see below) |
| `meta` | The scan cursor per chain and contract |

Writes are idempotent (`on conflict do nothing`), so restarts, crashes and re-scans never duplicate rows. To re-scan from an earlier block, lower the cursor row in `meta`.

## Database

The code uses Bun's SQL client, so one code path runs on both engines:

- **SQLite** (default): `sqlite://./data/indexer.db`. Good for development and a single backend. Put `data/` on a durable volume in any container; it is git-ignored.
- **Postgres**: `DATABASE_URL=postgres://user:pass@host:5432/db`. The SQL is portable, but only SQLite has been run against it so far. Test your Postgres before relying on it.

## How scanning works

Each pass reads the chain head, then fetches logs from the cursor in ranges (2,000 blocks to start). If the RPC rejects a range, the range halves until it is accepted. The cursor moves forward after every committed batch. Logs are requested for the contract address only and decoded locally, because a filter listing every event topic exceeded the public testnet RPC's request limit.

The first run starts at the deployment block (from `VITE_ORDERS_DEPLOY_TX_ARC_*`), or `INDEXER_START_BLOCK`, or the last 50,000 blocks if neither is set. Arc has deterministic finality, so there is no reorg handling; do not point this at a chain that can reorg without adding a trailing re-scan window.

## Endpoints

All read endpoints return `503 INDEXER_DISABLED` when the indexer is off, and honour `ALLOWED_ORIGINS`.

| Endpoint | Purpose |
| --- | --- |
| `GET /history?owner=0x..&limit=50&before=<block>` | The owner's events, newest first. `next` is the block to pass as `before` for the next page, or `null` at the end |
| `GET /swaps?owner=0x..&limit=50` | The owner's verified market swaps |
| `GET /stats` | Cursor, head, lag in blocks, event counts per name, swap count |
| `POST /swaps` `{ "chainId": 5042002, "hash": "0x.." }` | Report a confirmed market swap |

`GET /health` includes an `indexer` block (cursor, head, `lagBlocks`, last error; the raw error is shown only to operators).

## Why a swap report cannot be forged

Market swaps never touch the order contract, so nothing onchain marks them as this app's. The browser reports a transaction hash after it confirms, and the backend ignores everything else the caller says. It fetches the receipt itself and accepts the swap only if:

1. the transaction succeeded and was sent to a known swap contract for that chain (0x AllowanceHolder, the KyberSwap router, or the testnet routers; see `server/gateway/targets.ts`);
2. exactly one token left the sender and exactly one other token arrived, derived from the ERC-20 `Transfer` logs (a refund of part of the input is netted out).

Arc emits a `Transfer`-shaped log for the native gas fee from the pseudo-address `0xfffffffffffffffffffffffffffffffffffffffe`; it is ignored. This was found by running the verifier against a real testnet swap: without the exception the swap was rejected as ambiguous.

A wrong or forged hash can therefore only fail verification. `POST /swaps` has its own per-client rate limit (30 per minute).

## Operating it

| Signal | Meaning | Action |
| --- | --- | --- |
| `indexer.lagBlocks` rising | Scanning slower than the chain | Check RPC limits and latency; shrink `INDEXER_INTERVAL_MS` |
| `indexer.lastError` set | The last pass failed | An alert is sent once per 15 minutes when `ALERT_WEBHOOK_URL` is set; most RPC failures clear on the next pass |
| Cursor stuck | A single block range keeps failing | Check the RPC; the indexer halves the range down to one block before giving up |

Configuration: `INDEXER_ENABLED`, `INDEXER_NETWORK` (`arc-testnet` or `arc`), `INDEXER_INTERVAL_MS`, `INDEXER_START_BLOCK`, `DATABASE_URL`. See [configuration.md](configuration.md).

## Limits

- One chain per backend process. Run another process (and database) for the second network.
- No per-position PnL view yet; the data is there for it.
- The frontend merges server swaps into Trade history, but order history and positions still read the chain directly.
