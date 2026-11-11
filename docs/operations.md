# Operations runbook

## Start

```bash
bun install
bun run dev        # frontend on :5173
bun run server     # backend on :3001
```

Backend with a keeper:

```bash
KEEPER_ENABLED=true KEEPER_NETWORK=arc-testnet KEEPER_PRIVATE_KEY=<dedicated key> bun run server
```

Bun loads `.env` at start, so restart the backend after editing it. Vite also reads `.env` only at start; restart the dev server after changing a `VITE_` variable. Always start the backend with `bun`, not `node`.

## Health checks

| Check | Command | Healthy |
| --- | --- | --- |
| Backend up | `curl localhost:3001/health` | `"ok": true` |
| 0x configured | same, `zeroEx.configured` | `true` on mainnet setups |
| Keeper running | same, `keeper.running` | `true`, `lastError` null, `lastTick` recent |
| Load | `curl localhost:3001/metrics` | `keeper.lastTickMs` well below the interval; `rateLimited` near 0 |
| Cache | `/metrics` `http.cacheHits` vs `cacheMisses` | Hits dominate during bursts |

Through the dev proxy, use `/api/health` and `/api/metrics` on the app's port.

## What to watch

| Signal | Meaning | Action |
| --- | --- | --- |
| `lastTickMs` approaching the interval | Keeper saturated | Add shards, raise the interval, lower per-tick cap |
| `backedOff` growing | Many items failing simulation or without routes | Inspect: unsupported pair, size too large for liquidity, target not allowlisted, paused contract |
| `failedExecutions` rising | Executions revert at simulation | Check oracle freshness and the order's minimum versus the quote |
| `lastError` set | Last tick failed | Read the message; RPC problems usually self-heal on the next tick |
| `rateLimited` rising | Clients exceed limits | Check for a loop in a client; raise `RATE_LIMIT_SCALE` only if legitimate |
| Keeper balance low | Cannot pay gas | Fund the keeper address (USDC is the gas token on Arc) |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Trade controls disabled on testnet | No oracle and no 0x on testnet | Expected. Use your own deployment with a feed, or use mainnet after review |
| "No oracle feed for TOKEN" | Feed not applied on the contract | Queue the feed, wait the delay, apply it |
| "Oracle price is stale" | Feed older than `maxStaleness` | Check the feed on Chainlink's explorer; raise staleness only if the heartbeat justifies it |
| Order created but never executes | No keeper running, trigger not met, or unfavourable market vs minimum | Check Automation card and the order's status text; start a keeper |
| Trailing stop sits low | Nobody called `pokeTrailing` during the rally | Run a keeper; it records highs each tick |
| Quote form says offline | Backend not running or the proxy target is wrong | `bun run server`; confirm port 3001 |
| 429 from the backend | Rate limit | Wait for `retry-after`; reduce polling |
| Transaction never appears | Fee below Arc's 20 gwei floor | Resubmit with a higher max fee |
| Wallet shows wrong chain | Wallet on another network | Use the header switch button |
| Blank page after env change | Dev server needs restart | Restart Vite |

## Rotating the keeper key

1. Start the new keeper with a new funded key (a second instance is safe).
2. Stop the old instance.
3. Sweep the old key's remaining USDC.

The key never needs on-chain permissions: the contract is permissionless.

## Rotating the 0x API key

Set the new `ZEROEX_API_KEY` and restart the backend. The key is read per request but Bun loads it at start, so a restart is required.

## Incident playbook

| Incident | Steps |
| --- | --- |
| Suspected bad feed or hostile config | Owner calls `disableToken` or `disableSwapTarget` (instant); if needed `pause()`. Users can still cancel and refund |
| Compromised owner key | If the owner is uncompromised elsewhere, `pause()`. Queued configs are visible through `ConfigQueued`; `cancelConfig` them. Move to a new deployment |
| 0x outage | Market swaps and keeper executions fail; conditional orders stay escrowed and executable later; users can cancel |
| Chainlink feed stale | Executions revert (`StalePrice`); orders stay open; cancel and expire still work |
| Keeper compromised | The key only controls gas funds and cannot take escrow; rotate it |

## Backups and state

The backend is stateless: the keeper rebuilds its working set from the chain on restart. The browser keeps settings, market-swap hashes and a log cache in local storage; clearing it only costs a rescan. If you add a database for indexing later, put it on durable storage.
