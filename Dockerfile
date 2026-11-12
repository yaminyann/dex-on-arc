# syntax=docker/dockerfile:1.7
#
# One Dockerfile, two images:
#   target "api"  - the Bun backend (quote gateway, keeper, indexer, admin status API)
#   target "web"  - nginx serving the built frontend and proxying /api to the api service
# docker-compose.yml builds both. Public VITE_* values are baked into the web image at build time;
# secrets (ADMIN_TOKEN, KEEPER_PRIVATE_KEY, API keys) only ever reach the api container at run time.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------- frontend build ----------
# Built with Node, not Bun: the Vite build is lighter on Node. A build host with 4 GB of RAM or more is recommended.
FROM node:22-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=2560
COPY --from=deps /app/node_modules ./node_modules
ARG VITE_DEFAULT_NETWORK=arc-testnet
ARG VITE_ORDERS_ADDRESS_ARC_TESTNET=
ARG VITE_ORDERS_DEPLOY_TX_ARC_TESTNET=
ARG VITE_ORDERS_ADDRESS_ARC_MAINNET=
ARG VITE_ORDERS_DEPLOY_TX_ARC_MAINNET=
ARG VITE_SWAP_TARGETS_ARC=
ENV VITE_DEFAULT_NETWORK=$VITE_DEFAULT_NETWORK \
    VITE_ORDERS_ADDRESS_ARC_TESTNET=$VITE_ORDERS_ADDRESS_ARC_TESTNET \
    VITE_ORDERS_DEPLOY_TX_ARC_TESTNET=$VITE_ORDERS_DEPLOY_TX_ARC_TESTNET \
    VITE_ORDERS_ADDRESS_ARC_MAINNET=$VITE_ORDERS_ADDRESS_ARC_MAINNET \
    VITE_ORDERS_DEPLOY_TX_ARC_MAINNET=$VITE_ORDERS_DEPLOY_TX_ARC_MAINNET \
    VITE_SWAP_TARGETS_ARC=$VITE_SWAP_TARGETS_ARC
# Only what the build reads, so editing nginx or server files does not rerun the (slow, memory-hungry) build.
COPY package.json index.html vite.config.ts tailwind.config.js postcss.config.js tsconfig.json ./
COPY src ./src
RUN node node_modules/vite/bin/vite.js build

# ---------- web (nginx) ----------
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1

# ---------- api (Bun) ----------
FROM oven/bun:1 AS api
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json tsconfig.server.json ./
COPY server ./server
COPY src ./src
# The indexer database lives here. Mount a volume on it or history is rebuilt from chain on every deploy.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
