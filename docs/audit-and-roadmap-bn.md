# Arc Terminal: অডিট রিপোর্ট ও Production Roadmap (বাংলা)

তারিখ: 2026-11-12। এটি কোড, docs, এবং আমার চালানো টেস্ট/রান থেকে তৈরি। যা যাচাই করিনি তা "অযাচাইকৃত" লেখা আছে।

---

## ১. প্রজেক্ট কী এবং কীভাবে কাজ করে

Non-custodial trading terminal, Arc-এর উপর:

- **Market swap**: ব্রাউজার -> আপনার Bun backend (`/price`, `/quote`) -> 0x AllowanceHolder। ইউজার নিজের wallet দিয়ে সই করে। কোনো escrow নেই।
- **Conditional order ও DCA**: `ArcTradeOrders.sol`-এ ফান্ড escrow হয়। Limit, Stop-loss, Take-profit, Stop-limit, Trailing, OCO, DCA। যে কেউ (keeper) `execute()` call করতে পারে এবং output-এর 0.10% পর্যন্ত fee পায়।
- **Trigger-এর দাম** আসে Chainlink feed থেকে, DEX থেকে নয়। Keeper শুধু swap calldata দেয়। Contract exact-spend ও minimum-output balance-delta check করে।
- **Keeper** (`server/keeper.ts`): Multicall3 batching, sharding, backoff আছে।
- **Prompt Station**: শুধু UI, LLM নেই।

আর্কিটেকচার ভালো: contract-এ owner escrow তুলতে পারে না, config timelock আছে, execution revert করে (griefing-resistant)।

---

## ২. আমি যা চালিয়েছি (ফলাফল)

| ধাপ | ফলাফল |
| --- | --- |
| `bun install` | সফল, 842 package। দ্রষ্টব্য: PATH-এর `bun` shim ভাঙা ("proxy failed to run bun")। আসল binary `~/.bun/bin/bun` (v1.4.2, প্রজেক্ট pin 1.3.14) |
| `bun test` | 27 টেস্ট পাস, 0 ফেল |
| `bun run typecheck` | **ফেল**: `scripts/compass-deploy.ts` -> `@circlefin/compass-chains` module নেই |
| `oxlint` | কোনো error নেই |
| Backend `:3001` ও Vite `:5173` | চালু। `/health`, `/metrics` ঠিক। `/price` -> `ZEROEX_NOT_CONFIGURED` (0x key নেই, প্রত্যাশিত) |
| UI (browser) | রেন্ডার হয়, console error নেই। Arc Testnet banner ও tBTC/USDC pair দেখা গেছে |
| Foundry (169 contract test) | **চালাতে পারিনি**: `forge` ইনস্টল নেই। তাই contract test ফলাফল অযাচাইকৃত |
| Keeper, 0x আসল calldata, mainnet | চালাইনি (key নেই, mainnet deploy নেই) |

---

## ৩. Gap তালিকা (গুরুত্ব অনুযায়ী)

### P0: Production-এর আগে অবশ্যই ঠিক করতে হবে

1. **Rate limiter bypass (যাচাই করা)**: `x-forwarded-for` header client নিজেই দেয়, server তা বিশ্বাস করে (`server/index.ts:35`)। আমি 30টি `/quote` request আলাদা fake IP দিয়ে পাঠিয়েছি, সবগুলো পাস (সীমা 20/মিনিট)। ফলে যে কেউ আপনার 0x API quota শেষ করতে পারে।
2. **`/quote` ও `/price` সম্পূর্ণ খোলা proxy**: কোনো auth/origin check নেই। `/health` keeper address দেখায়, `/metrics` unauthenticated।
3. **Frontend backend-এর দেওয়া `transaction.to/data/value` অন্ধভাবে wallet-এ পাঠায়** (`MarketForm.tsx:60`)। backend compromise হলে বা MITM হলে ইউজারকে যেকোনো contract-এ সই করানো যায়। সমাধান: `to`-কে ক্লায়েন্টে hardcoded 0x AllowanceHolder allowlist-এ pin করা, `value == 0` বাধ্য করা, approval spender একই allowlist থেকে।
4. **কোনো audit নেই**, mainnet deploy নেই, fork test নেই (`contracts/test-integration/` খালি)। আসল 0x/Chainlink/Arc token-এর বিরুদ্ধে কখনো টেস্ট হয়নি।
5. **Oracle-এর মান স্টপ-লসের জন্য দুর্বল**: Chainlink Arc feed-এ 24 ঘণ্টা heartbeat ও ~0.5% deviation। Stop-loss/trailing-এর trigger এই বাসি দামে চলে। Contract-এ round check, deviation guard, min/max bound নেই; decimals cache করা।
6. **Keeper single point of failure ও আর্থিকভাবে অন্ধ**:
   - Profitability check নেই (fee বনাম gas বনাম 0x খরচ)। Contract-এ minimum order size নেই, তাই dust order দিয়ে keeper-কে ক্ষতিতে ফেলা যায়।
   - প্রতিটি tx সিরিয়ালি পাঠায় ও receipt-এর জন্য অপেক্ষা করে; nonce/gas-bump/replace নেই।
   - Private key plain env var। KMS/HSM নেই।
   - Shard মরে গেলে failover নেই; leader election নেই।
   - `allowFailure: false` multicall: একটি call fail করলে পুরো batch/tick fail ("poison pill")।
   - Alert/pager নেই; শুধু `/metrics` JSON।
7. **Repo hygiene**: git repository নয়, CI নেই (`.github` নেই), typecheck ভাঙা, Dockerfile নেই, backend/keeper-এর কোনো টেস্ট নেই (27 টেস্ট একটি ফাইলে, বেশিরভাগ math/UI helper)।

### P1: গুরুত্বপূর্ণ

8. **শুধু একটি aggregator (0x)**: fallback নেই, quote তুলনা নেই, circuit breaker নেই। 0x down হলে সব swap ও সব execution বন্ধ।
9. **Price cache hit-ratio কম**: cache key-তে `taker` আছে (`server/index.ts:79`), তাই আলাদা ইউজারদের একই pair-এর request share হয় না। Docs-এর "N ইউজার = 1 upstream call" দাবি ভুল।
10. **Price impact/oracle deviation guard নেই**: UI oracle-এর সাথে পার্থক্য দেখায়, কিন্তু বেশি হলে block করে না। Keeper-ও oracle-relative floor ছাড়া কিছু দেখে না (slippage সর্বোচ্চ 10%)। Searcher/MEV এই ব্যান্ডের ভিতরে মূল্য বের করতে পারে।
11. **Indexer নেই**: History/PnL ব্রাউজারে `getLogs` + `localStorage`। Market swap history শুধু ওই ব্রাউজারে; ডিভাইস বদলালে হারায়। PnL শুধু contract fill-এর।
12. **Contract সীমাবদ্ধতা**: একটাই quote token; stop/trailing শুধু sell-side; partial fill নেই; batch execute নেই; `getOrderIds` unbounded; `renounceOwnership` চালু; `activateStop`/`pokeTrailing`-এ কোনো incentive নেই; `ConfigQueued` event-এ কী queue হয়েছে তা নেই; queued config কখনো expire হয় না; per-order swap target বেছে নেওয়া যায় না।
13. **Chart দাম Coinbase reference**, Arc pool দাম নয়। Arc-native asset-এ বিভ্রান্তিকর।
14. **Mainnet token list খালি** (`networks.ts`), mainnet-এ কিছু trade হয় না যতক্ষণ না আপনি কনফিগ করেন।
15. **Wallet**: শুধু injected (docs অনুযায়ী); WalletConnect/smart account নেই।

### P2: Docs ও কনফিগ drift

- `AGENTS.md` ও `docs/deployment.md` বলে contract `0x7da5...`; আসলে `.env` ও `testnet-harness.json` `0x259d...` ব্যবহার করে (পুরনোটি superseded)।
- `docs/automation-and-keepers.md` বলে testnet-এ keeper শুধু maintenance করে; কোড test router দিয়ে swap-ও করে।
- Docs-এর "researched 2026-11-11" তথ্য আংশিক পুরনো (নিচে ৪ দেখুন)।
- Root-এ `console.jsonl`, `traces.jsonl` (প্রায় 400KB) debug ফাইল।
- `.env`-এ `TESTNET_DEPLOYER_PRIVATE_KEY` আছে। `.gitignore` ঠিক, কিন্তু প্রজেক্ট git repo না হওয়ায় সুরক্ষা শুধু ফাইল-স্তরে। কখনো `VITE_` দিয়ে প্রকাশ করবেন না।

---

## ৪. Arc ইকোসিস্টেম: কী পরিবর্তন হয়েছে (web search, অযাচাইকৃত onchain)

সূত্র অনুযায়ী Arc mainnet 2026-09-16 তে চালু হয়েছে। প্রতিটি দাবি deploy করার আগে অন-চেইনে যাচাই করুন (address, `decimals()`, pool depth)।

- **Uniswap v4** mainnet launch-এর সাথে live (pool, routing, SDK/API)। cirBTC প্রথম দিন থেকে Uniswap-এ। USDC/EURC pool আছে।
- **Aggregator**: 0x, 1inch, LI.FI live বলে বলা হচ্ছে; KyberSwap, SushiSwap ইত্যাদি directory-তে আছে। Curve-এর mainnet প্রমাণ পাইনি।
- **Oracle**: Chainlink Data Feeds (Sep 9), **Data Streams (Sep 15)**, CCIP। Pyth, RedStone, Stork, Chronicle Arc docs-এ তালিকাভুক্ত। Chainlink Automation-এর কোনো প্রমাণ পাইনি (docs-এর সাথে মেলে)।
- **LI.FI** Circle CCTP route সহ cross-chain swap/bridge দেয়।
- Circle Gateway/CCTP/App Kit (Swap Kit) আছে। `@circle-fin/app-kit` আপনার `package.json`-এ আছে কিন্তু শুধু deploy scripts ব্যবহার করে, trading-এ নয়।

সূত্র:
- https://community.arc.io/public/blogs/arc-x-uniswap-swap-and-liquidity-infrastructure-for-arc-2026-06-15
- https://www.arc.io/blog/how-arc-supports-onchain-trading-and-dex-infrastructure-arc-blueprints
- https://builder.registrai.cc/ecosystem/dexs/
- https://docs.arc.io/arc/tools/oracles
- https://cryptobriefing.com/chainlink-expands-arc-mainnet-mova-chain/

---

## ৫. Aggregator ব্যবহার করে আরও advanced করার পরিকল্পনা

### ৫.১ Multi-aggregator Router Layer (সবচেয়ে বড় লাভ)

বর্তমান `AggregatorAdapter` (শুধু `price`/`quote`) বাড়িয়ে:

```
QuoteGateway (backend)
 ├─ adapters: 0x, 1inch, LI.FI, Kyber, Uniswap v4 (direct Universal Router), Circle Swap Kit
 ├─ সমান্তরালে quote নিয়ে ranking: net output (minBuyAmount - gas) অনুযায়ী
 ├─ per-adapter timeout, health score, circuit breaker, fallback
 ├─ simulation: eth_call দিয়ে calldata যাচাই, তারপরই ক্লায়েন্টকে দেওয়া
 └─ taker-বিহীন cache key (price), আলাদা short-TTL per-taker cache (quote)
```

- প্রতিটি aggregator-এর swap target contract-এ allowlist করুন (timelock দিয়ে)। Contract-কে `execute(id, target, data)` অপরিবর্তিত রেখেও চলে; keeper সবচেয়ে ভালো route বেছে নেবে।
- UI-তে "Best route" তুলনা, route source দেখানো।
- **Revenue**: aggregator integrator fee (0x/1inch affiliate fee) যোগ করুন; এখন কোনো fee নেই।
- **Cross-chain "যেকোনো চেইন থেকে Arc-এ কিনুন"**: LI.FI/Gateway/CCTP দিয়ে। এটি একটি আলাদা user flow, escrow contract স্পর্শ করে না।

### ৫.২ নিরাপত্তা guard

- Client-side pinned target allowlist (৩.৩ দেখুন)।
- Oracle বনাম quote deviation ছাড়ালে (যেমন >1-2%) block বা সতর্কতা + confirmation।
- Keeper-এ per-order "max price impact" ও pre-flight profitability check।
- MEV সুরক্ষা: Arc-এর mempool/private submission অপশন যাচাই করুন; না থাকলে tight slippage ও oracle floor-ই ভরসা।

### ৫.৩ Oracle আপগ্রেড

- Data Streams বা Pyth (pull-based, কম latency) এর জন্য `IPriceSource` adapter: execution-এর সময় signed report verify করা। Stop-loss-এর বাসি-দাম সমস্যার সবচেয়ে বড় সমাধান।
- দুটি oracle-এর মধ্যে deviation guard (Chainlink + Pyth), round-completeness check, min/max bound।

### ৫.৪ নতুন ফিচার (contract v2 এ)

- Buy-side stop, একাধিক quote token (USDC/EURC), partial fill/TWAP order, `executeMany` batch, paged views, minimum order size, per-order allowed-aggregator, queued config-এ পূর্ণ event data, `renounceOwnership` বন্ধ।
- Wallet: WalletConnect + Circle Modular Wallets (passkey)। Gas USDC-তে, তাই gas sponsorship এর বদলে পরিষ্কার USDC gas UX।
- Prompt Station: LLM শুধু structured order খসড়া করবে; সব plan simulation + ইউজার সই পাস করবে।

---

## ৬. Production Roadmap

### Phase 0: ভিত্তি (3-5 দিন)

- `git init`, CI (lint, typecheck, `bun test`, `forge test`)। `compass-deploy.ts` ঠিক বা সরান।
- Foundry ইনস্টল করে 169 টেস্ট চালান; ফলাফল সংরক্ষণ করুন।
- Rate limiter: `x-forwarded-for` শুধু trusted proxy থেকে; নইলে socket IP। `/quote`-তে auth বা short-lived signed token; `/metrics`, `/health` সীমিত।
- Frontend target pinning। Docs drift ঠিক করুন। Root debug ফাইল সরান।
- বাধ্যতামূলক exit: সব check সবুজ, spoofed-XFF টেস্ট ব্যর্থ হয় (অর্থাৎ block হয়)।

### Phase 1: Quote Gateway ও Keeper hardening (1-2 সপ্তাহ)

- Multi-aggregator gateway (০x + কমপক্ষে আরও একটি), taker-বিহীন cache, Redis।
- Keeper: concurrent tx + nonce manager, gas-bump, profitability/min-notional check, `allowFailure: true`, KMS/Circle developer-controlled wallet দিয়ে key, leader lease/failover, event-driven (WebSocket) + polling fallback।
- Observability: Prometheus/Grafana, Sentry, alert (keeper balance, lastTick, failed rate, oracle stale)।
- Multi-RPC fallback (viem `fallback` transport)।

### Phase 2: Indexer ও টেস্টিং (1-2 সপ্তাহ)

- Event indexer + Postgres (volume সহ) -> history, PnL, market swap রেকর্ড (backend থেকে)।
- Arc mainnet fork test: আসল 0x/1inch calldata, আসল Chainlink feed, আসল token (cirBTC, EURC)।
- Keeper ও server-এর integration/unit টেস্ট; load টেস্ট।

### Phase 3: Contract v2 ও audit (3-6 সপ্তাহ)

- ৫.৪ ও ৫.৩ বাস্তবায়ন, তারপর independent audit। Audit ছাড়া mainnet-এ প্রকৃত ফান্ড নয়।
- Owner = multisig (Safe), configDelay >= 48 ঘণ্টা, ConfigQueued monitoring bot।

### Phase 4: Mainnet beta (সীমিত)

- Token allowlist (শুধু গভীর liquidity-র pair), per-user ও মোট TVL cap, kill switch (`pause`), incident playbook রিহার্সাল।
- ধাপে ধাপে cap বাড়ান। Keeper একাধিক অপারেটর/key।

### Phase 5: স্কেল

- Services আলাদা: quote-gateway, keeper pool, indexer, API; autoscaling।
- ডেডিকেটেড RPC provider; keeper sharding + auto-failover।
- Cross-chain onboarding, WalletConnect/passkey wallet, Prompt Station।

---

## ৭. যা আমি যাচাই করিনি

- Foundry 169 টেস্ট (forge নেই)।
- Keeper-এর আসল execution, আসল 0x/1inch response, Arc mainnet contract/pool/feed address।
- Web search-এর ইকোসিস্টেম তথ্য (সূত্র ভিন্নমত দেখায়: Curve; pool depth)।
- Frontend production build ও bundle size।
- Security-র ৩.৩ ও ৩.১ ফাইন্ডিং কোড থেকে নিশ্চিত, ৩.১ চালিয়ে প্রমাণিত; বাকিগুলো কোড পড়ে।

---

## ৮. P0 স্ট্যাটাস (2026-11-12 আপডেট)

| P0 আইটেম | স্ট্যাটাস |
| --- | --- |
| Rate limiter bypass | ঠিক হয়েছে। `x-forwarded-for` ডিফল্টে উপেক্ষিত (`TRUSTED_PROXY_HOPS`)। লাইভ টেস্ট: fake IP দিয়ে 30 request -> মাত্র 20টি পাস |
| খোলা `/quote`, `/metrics`, `/health` | `/metrics` অপারেটর-only (`ADMIN_TOKEN` বা loopback)। Public `/health` এ keeper address ও raw error লুকানো। `ALLOWED_ORIGINS` গেট ও গ্লোবাল 0x budget (`UPSTREAM_BUDGET_PER_MIN`) যোগ হয়েছে |
| Frontend target pinning | ঠিক হয়েছে। Swap target/approval spender allowlist ছাড়া হলে wallet-এ যায় না, native value 0 বাধ্য |
| Keeper poison pill | ঠিক হয়েছে। `allowFailure: true`, ব্যর্থ read পরের tick-এ retry/backoff |
| Keeper error-এ RPC token leak | ঠিক হয়েছে (`redactSecrets`) |
| typecheck ও CI | typecheck সবুজ; GitHub Actions CI যোগ হয়েছে (forge job এখনো এই মেশিনে যাচাই হয়নি) |
| Docs drift | ঠিক হয়েছে (AGENTS.md, deployment.md, configuration.md, backend-api.md) |
| Independent audit, fork test, oracle (Data Streams/Pyth), keeper concurrency/KMS/failover/min-notional | **বাকি**। Contract পরিবর্তন বা বাইরের কাজ লাগে (Phase 1-3) |

---

## ৯. Phase 1 স্ট্যাটাস (2026-11-12)

| আইটেম | স্ট্যাটাস |
| --- | --- |
| Multi-aggregator gateway | হয়েছে: 0x + KyberSwap (keyless; Arc mainnet এ লাইভ route/build যাচাই করা)। সমান্তরাল quote, `minBuyAmount - gas` দিয়ে ranking, timeout, per-provider budget, circuit breaker, `eth_call` simulation (ব্যর্থ quote নামানো হয়) |
| Kyber router সুরক্ষা | API-র দেওয়া router allowlist-এ না থাকলে বা sell amount না মিললে প্রত্যাখ্যান; ফ্রন্টএন্ডেও pinned |
| Keeper | nonce manager + পরপর broadcast + সমান্তরাল confirm; profitability check (fee < gas হলে skip); 20 gwei gas floor; standby role (stateless failover); `KEEPER_PRIVATE_KEY_FILE`; multi-RPC fallback |
| Observability | Prometheus (`/metrics?format=prometheus`), webhook alert (low balance, tick failure, provider breaker), error-এ URL/key redact |
| টেস্ট | 73 টেস্ট পাস (গেটওয়ে, Kyber fixture, breaker, keeper-core, alerts, prometheus সহ) |
| লাইভ যাচাই | Gateway `/price` ও `/quote` Arc mainnet এ Kyber দিয়ে কাজ করেছে। Keeper testnet এ চালিয়ে 8 tx পাঠিয়েছে, 0 ব্যর্থ |
| বাকি | KMS/HSM signing, WebSocket event-driven wake, Sentry, Redis shared cache, taker-বিহীন price cache key, আসল 0x key দিয়ে 0x provider পরীক্ষা, Kyber router কে অন-চেইন contract এ allowlist (owner, timelock) |
