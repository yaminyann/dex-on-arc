# Deploying on Coolify (Docker Compose)

This is the production-style way to run Arc Terminal: two containers from one repository, one domain, TLS from Coolify's proxy. It is tested on Arc Testnet. **Mainnet is not deployed by this guide**: the order contract on mainnet is yours to deploy after an audit (see [mainnet-readiness-checklist.md](mainnet-readiness-checklist.md)). Until then a mainnet deployment of the app gives market swaps only.

## What gets deployed

| Service | Image | What it does | Public? |
| --- | --- | --- | --- |
| `web` | nginx + the built frontend | Serves the app, forwards `/api/*` to `api` | Yes, port 80 behind Coolify's proxy |
| `api` | Bun | Quote gateway, **keeper** (executes orders and DCA), **indexer** (history, owner log), token list, admin status | No, internal only |

Files: [`Dockerfile`](../Dockerfile) (targets `web` and `api`), [`docker-compose.yml`](../docker-compose.yml), [`deploy/nginx.conf`](../deploy/nginx.conf), [`scripts/coolify/gen-env.ts`](../scripts/coolify/gen-env.ts), [`scripts/coolify/preflight.ts`](../scripts/coolify/preflight.ts).

Run **one** `api` container. The keeper and the indexer keep state and must not run twice (two keepers would race on the same orders). Scale reads by caching in front of `web`, not by adding `api` replicas. See [scaling.md](scaling.md) for keeper sharding if you ever outgrow one keeper.

## 1. Prepare the environment file

On your machine, in the repository:

```bash
bun install
bun run scripts/coolify/gen-env.ts --new-keeper-key
```

This writes `deploy/coolify/production.env` (git-ignored, file mode 600) containing:

- a random 64-character `ADMIN_TOKEN`;
- a brand-new keeper wallet (`KEEPER_PRIVATE_KEY`) and prints its address;
- the public testnet values copied from your local `.env`;
- every other setting with a safe default and a comment.

Use `--mainnet` for mainnet defaults, `--out <file>` to choose another path, `--force` to overwrite (this rotates the admin token).

Then:

1. **Fund the keeper wallet** with a little USDC for gas (testnet: the Circle faucet; mainnet: a few USDC). Arc's gas token is USDC. The keeper earns the keeper fee back from executions.
2. Edit the file: set `ALLOWED_ORIGINS` to your public URL (for example `https://terminal.example.com`), and, if you want a swap fee, `PLATFORM_FEE_BPS` and `PLATFORM_FEE_RECIPIENT` (see [admin-guide.md](admin-guide.md)).
3. Check it:

```bash
bun run scripts/coolify/preflight.ts deploy/coolify/production.env
```

Preflight reads the same variables the compose file uses and asks the chain: RPC is the right network, the order contract has code and who owns it, the keeper wallet has gas, the keeper key is not the owner key, the platform fee settings are valid. It exits with code 1 when something must be fixed and prints warnings for the rest.

## 2. Create the resource in Coolify

1. **Project -> New resource -> Docker Compose** (from a Git repository). Point it at this repository and the branch you deploy (`main`). Base directory `/`, compose file `/docker-compose.yml`.
2. Open **Environment Variables** and use the **Developer view**. Paste the contents of `deploy/coolify/production.env`. Coolify lists every `${VARIABLE}` the compose file uses; `ADMIN_TOKEN` is required (the deploy refuses to start without it).
3. Mark the `VITE_*` variables as **Build variables** if Coolify offers the checkbox (they are baked into the web image at build time).
4. Open the `web` service and set its **Domain** to your hostname with port `80`, for example `https://terminal.example.com:80`. Leave `api` without a domain.
5. Persistent storage: the compose file declares the `api-data` volume for the indexer database. Keep it, or the indexer re-reads history from the chain on every deploy.
6. **Deploy.**

Compose healthchecks decide readiness: `api` answers `/health`, then `web` answers `/healthz`.

## 3. Verify

1. Open the domain. The app loads on the network you chose in `VITE_DEFAULT_NETWORK`.
2. `https://<domain>/api/health` returns JSON with `"ok": true` and, on testnet, providers `test-router` and `test-router-b`.
3. Connect the **owner** wallet. An **Admin** tab appears. Under **Backend status** paste the `ADMIN_TOKEN`: you should see the keeper running, its gas balance, provider status and indexer lag.
4. Place a small stop-loss with test tokens (Trade -> Testnet tools -> Get tokens) and watch the keeper fill it after you move the test price. On testnet this exercises everything end to end.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | **Yes** | Bearer token for operator endpoints. Min 24 characters |
| `VITE_DEFAULT_NETWORK` | No (`arc-testnet`) | `arc` or `arc-testnet`. Which network a new visitor sees |
| `KEEPER_NETWORK`, `INDEXER_NETWORK` | No (`arc-testnet`) | Network the keeper and indexer watch. Keep equal to the default network |
| `VITE_ORDERS_ADDRESS_ARC_TESTNET`, `VITE_ORDERS_DEPLOY_TX_ARC_TESTNET` | For testnet orders | Contract and deployment transaction |
| `VITE_ORDERS_ADDRESS_ARC_MAINNET`, `VITE_ORDERS_DEPLOY_TX_ARC_MAINNET` | For mainnet orders | Set after you deploy on mainnet |
| `VITE_SWAP_TARGETS_ARC` | No | Extra reviewed routers the browser may swap through on mainnet |
| `KEEPER_ENABLED` | No (`true`) | Runs the keeper inside `api` |
| `KEEPER_PRIVATE_KEY` | If keeper enabled | Dedicated low-balance wallet. Never the owner key |
| `PLATFORM_FEE_BPS`, `PLATFORM_FEE_RECIPIENT` | No (`0`) | Swap fee (max 100 = 1%) and where it is paid |
| `GATEWAY_PROVIDERS` | No | Quote providers. Default includes both testnet routers; they never answer on mainnet |
| `ZEROEX_API_KEY` | No | Adds 0x as a provider on mainnet. KyberSwap needs no key |
| `RPC_URL_Arc`, `RPC_URL_Arc_Testnet` | No | Comma-separated RPC list with failover. Empty uses the public RPC |
| `KEEPER_WS_URL` | No | WebSocket RPC so new orders wake the keeper immediately |
| `INDEXER_ENABLED`, `INDEXER_INTERVAL_MS`, `DATABASE_URL` | No | Indexer on by default with SQLite on the volume. Postgres: `postgres://user:pass@host:5432/db` (SQLite is the tested path) |
| `TRUSTED_PROXY_HOPS` | No (`2`) | Proxies between the internet and `api`. Coolify's proxy + nginx = 2; add 1 behind Cloudflare |
| `ALLOWED_ORIGINS` | Recommended | Your public origin. Stops other sites using your quote service |
| `ALERT_WEBHOOK_URL` | No | Slack/Discord-style webhook for keeper and provider alerts |

Never put a secret in a `VITE_*` variable: those are public and end up in the JavaScript bundle.

## Operations

- **Update**: push to the branch; Coolify rebuilds. Env changes to `VITE_*` need a rebuild of `web`; everything else only restarts `api`.
- **Rotate the admin token**: change `ADMIN_TOKEN`, redeploy `api`.
- **Rotate the keeper key**: fund the new wallet first, change `KEEPER_PRIVATE_KEY`, redeploy. Orders are unaffected: any wallet may execute them.
- **Low keeper gas**: the Admin page shows the balance and warns under 1 USDC; `ALERT_WEBHOOK_URL` also alerts.
- **Logs**: Coolify -> the service -> Logs. Secrets are redacted from log lines and alerts.
- **Backups**: only the `api-data` volume matters (indexer database). It is rebuildable from the chain, so a lost volume costs time, not data.
- **Pause in an emergency**: Admin page -> Pause trading (needs the owner wallet). Refunds and cancels keep working.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Deploy stops at "set ADMIN_TOKEN" | Required variable missing | Add it in the environment tab |
| App loads but "Quote service offline" | `api` unhealthy or `/api` not proxied | Check `api` logs and `https://<domain>/api/health` |
| Everyone gets 429 | `TRUSTED_PROXY_HOPS=0` behind the proxy, so all users share one address | Set it to `2` |
| Orders never fill | Keeper off, no gas, or unprofitable | Admin page -> Backend status; fund the keeper wallet |
| Admin tab missing | Connected wallet is not the owner | Connect the owner wallet |
| "Owner history needs the indexer" | `INDEXER_ENABLED` is not `true` or still syncing | Enable it; check indexer lag |
| Token list empty on mainnet | KyberSwap registry unreachable from the server | Check outbound HTTPS from the container |
