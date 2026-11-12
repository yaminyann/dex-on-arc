# Arcora (Arc Terminal): সম্পূর্ণ গাইড (বাংলা)

এই গাইডে আছে: কয়েন লিস্ট কীভাবে কাজ করে, প্ল্যাটফর্ম ফি ও অ্যাডমিন কন্ট্রোল, লোকালি চালানো ও টেস্ট করা, Coolify তে Docker Compose দিয়ে ডেপ্লয়, `.env` এর প্রতিটি ভ্যারিয়েবল, এবং mainnet এ যাওয়ার আগের চেকলিস্ট।

> **মনে রাখবেন:** mainnet এ কিছু ডেপ্লয় করা হয়নি। Mainnet এ অর্ডার কন্ট্রাক্ট আপনি নিজে অডিটের পর ডেপ্লয় করবেন। কন্ট্রাক্ট এখনো **unaudited**।

---

## ০. নতুন: প্ল্যাটফর্মের নাম, পেজ, Agent Station ও Settings

**নাম: Arcora** (Arc + aurora)। লোগো হলো একটি arch (arc) আর তার ওপরে একটি উঠতে থাকা বিন্দু; accent রঙ বদলালে লোগোও বদলায়। নামটি ডোমেইন ও trademark এ খালি আছে কি না আপনি যাচাই করে নিন। নাম, tagline ও সব লিংক `src/brand.ts` এ এক জায়গায়।

**পেজ:** Trade, Dashboard, Lending, Agent (আর owner হলে Admin)। Layout Hyperliquid এর ঢঙে (ঘন dark panel: উপরে price header, chart ও order form, নিচে orders table আর পাশে Account box), কপি নয়।

- **Dashboard:** Account value, available, escrow, realized / unrealized PnL, balances, সব order, DCA ও fill।
- **Lending:** শুধু ডিজাইন (Preview)। কোনো lending market যুক্ত নেই, তাই rate ও total এ `—` দেখায়, বানানো সংখ্যা নেই। Wallet balance আসল। Market যুক্ত হলে এই layout এ বসবে।
- **Footer:** Online / network / keeper status, Docs, Terms, Privacy, Risk, social আইকন। Social লিংক শুধু তখনই দেখায় যখন `VITE_SOCIAL_X`, `VITE_SOCIAL_DISCORD`, `VITE_SOCIAL_TELEGRAM` সেট করা থাকে (GitHub ডিফল্টে এই repo)। আমি কোনো handle বানাইনি। Terms ও Privacy এখন সাধারণ ভাষার placeholder; আইনজীবীকে দিয়ে লিখিয়ে `VITE_TERMS_URL` ও `VITE_PRIVACY_URL` দিন।

### Settings (সঙ্গে সঙ্গে কাজ করে, ব্রাউজারে সেভ থাকে)

| ট্যাব | কী বদলানো যায় |
| --- | --- |
| Look | Theme (Dark / Light / System), accent রঙ (৫টি), interface size (Compact / Default / Large), testnet নোট |
| Trading | Max slippage, order expiry, order form কোন টাইপে খুলবে |
| Chart | Default timeframe, volume, moving average |
| Agent | Permission সারাংশ, Revoke, আজকের usage রিসেট |
| Data | Settings export, সব রিসেট |

### Agent Station (কমান্ডে সব কাজ)

এটা chat model নয়; একটি নির্দিষ্ট ব্যাকরণের **command interpreter**। একই লেখা সবসময় একই ফল দেয়; না বুঝলে উদাহরণ দিয়ে ফিরিয়ে দেয়, আন্দাজ করে না।

1. কমান্ড লিখুন: `buy 10 USDC of tBTC`, `sell 50% of tBTC`, `stop loss 0.001 tBTC at 80000`, `take profit ...`, `limit buy tBTC 5 USDC at 70000`, `trailing stop 0.001 tBTC 5%`, `oco 0.001 tBTC sl 80000 tp 100000`, `dca 1 USDC into tBTC daily for 7 days`, `cancel order 12`, `pause dca 3`। দেখার জন্য: `help`, `balance`, `orders`, `price tBTC`।
2. Agent আসল balance, oracle, quote ও contract এর minimum দিয়ে **plan বানায়** ও দেখায়: কত দিচ্ছেন, কত পাবেন (ন্যূনতম), slippage, expiry, fee, সতর্কতা। তারপর জিজ্ঞেস করে: **"Is this exactly what you want?"**
3. আপনি `yes` লিখলে (বা বোতামে চাপলে) তবেই চলে। `no` বা Cancel করলে কিছু যায় না।
4. এক মিনিটের পুরনো plan আবার নতুন করে বানিয়ে আবার জিজ্ঞেস করে। Market swap পাঠানোর সময় দাম 0.5% এর বেশি খারাপ হলে পাঠায় না।

**একবার permission:** প্রথম action এর সময় একবার অনুমতি দেন (কতক্ষণ: ১ ঘণ্টা / ২৪ ঘণ্টা / ৭ দিন / revoke পর্যন্ত; প্রতি কমান্ডে ও প্রতিদিনে সর্বোচ্চ USDC; কোন ধরনের কাজ: swap, orders, DCA, cancel/pause)। তারপর সীমার ভেতরে বারবার permission চায় না। চাইলে "Run inside limits" মোডে সীমার ভেতরের কমান্ড readback এর পরই চলে; সীমার বাইরে বা দাম বের করা না গেলে তখনও আপনার yes লাগে। ডান পাশের প্যানেলে যা দেওয়া আছে, কতটা ব্যবহার হয়েছে, আর Revoke বোতাম আছে।

> **সীমা:** Permission আপনার key ধরে না। **Wallet প্রতিটি transaction (approve সহ) এ নিজের confirm চাইবেই**, Agent এটা এড়াতে পারে না। কম popup চাইলে session-key wallet লাগবে, সেটা এখানে বানানো নেই।

বিস্তারিত: `docs/agent-station.md`।

---

## ১. কয়েন "মাত্র ৩টা" কেন ছিল, এখন কী বদলেছে

| নেটওয়ার্ক | কয়েন | কারণ |
| --- | --- | --- |
| **Arc Testnet** | tBTC, tETH, tSOL (টেস্ট টোকেন) | Testnet এ কোনো aggregator (0x/KyberSwap) নেই, Chainlink price feed নেই। তাই প্রতিটি অর্ডার টাইপ চেষ্টা করার জন্য প্রজেক্ট নিজের টেস্ট টোকেন, টেস্ট price feed ও টেস্ট রাউটার দেয়। এই ৩টাই testnet এ trade করা যায়। EURC, cirBTC, WETH এর testnet এ কোনো feed বা রাউটার নেই, তাই সেগুলো শুধু portfolio তে দেখা যায় |
| **Arc Mainnet** | **৫৯টি টোকেন** (USDC বাদে) | KyberSwap এর রেজিস্ট্রি থেকে লাইভ লোড হয়: `GET /api/tokens`। শুধু whitelisted এবং honeypot / fee-on-transfer নয় এমন টোকেন। নাম, সিম্বল বা কন্ট্রাক্ট অ্যাড্রেস দিয়ে সার্চ করা যায় |

Mainnet এ লিস্ট করা প্রতিটি টোকেনে **market swap** কাজ করে (USDC ↔ টোকেন)। **Limit / stop-loss / DCA** এর জন্য কন্ট্রাক্টে ওই টোকেনের oracle feed লাগে। Feed না থাকলে ফর্মে পরিষ্কার লেখা দেখায়: "No oracle feed for X"।

লাইভ যাচাই (Arc mainnet quote, কোনো ট্রেড না করে): ARCMAN এ 5 USDC → প্রায় 438.6 ARCMAN, route uniswap-v4, platform fee সারি দেখাচ্ছে।

> লিস্টে থাকা মানে টোকেন নিরাপদ নয়। এর মানে aggregator রুট করতে পারে। লঞ্চের আগে চাইলে একটি curated লিস্টে সীমাবদ্ধ করুন।

---

## ২. ফি (fee) কোথায় কী

| ফি | কোথায় লাগে | হার | কে পায় | কে ঠিক করে | বাড়ানো যায়? |
| --- | --- | --- | --- | --- | --- |
| **Keeper fee** | Order ও DCA fill (আউটপুট টোকেনে) | ডিপ্লয়ে 0.10% | যে wallet execution জমা দেয় (আপনার keeper চালালে আপনি) | Contract owner (Admin পেজ) | **না**: শুধু কমানো যায় |
| **Platform swap fee** | ব্রাউজারে market swap | 0 থেকে সর্বোচ্চ 1.00% (sell amount এর) | `PLATFORM_FEE_RECIPIENT` | Backend `.env` | হ্যাঁ, backend redeploy করে। কোডে hard cap 100 bps |
| Gas | সব কিছু | USDC তে | চেইন | n/a | n/a |

**Platform swap fee কীভাবে কাজ করে:** backend aggregator কে fee সহ quote চায়। রাউটার swap এর **একই transaction এ** ফি কেটে recipient কে পাঠায়। ইউজার যে quote দেখে সেটা ফি কাটার পরের সংখ্যা, আর ফর্মে "Platform fee" সারি থাকে। Backend কখনো ইউজারের বা ফির টাকা ধরে না।

সীমা:
- Order / DCA তে swap fee নেই। ওখানে আপনার রাজস্ব = keeper fee, তাই **নিজের keeper চালান**।
- Testnet এ swap fee নেই (টেস্ট রাউটার ফি নেয় না)। Mainnet এ ফি শুধু **quote** দেখে যাচাই করুন, ট্রেড করে নয়।
- ভুল সেটিং হলে ফি **বন্ধ** হয়ে যায়, চালু নয় (100 এর বেশি bps, recipient না থাকা, সংখ্যা না হওয়া)।
- Recipient সার্ভার ঠিক করে। সার্ভার হ্যাক হলে ফির রাজস্ব সরে যেতে পারে (ইউজারের টাকা নয়)। তাই recipient হিসেবে multisig বা cold wallet দিন।
- 0x এর fee প্যারামিটার কোডে আছে কিন্তু লাইভ 0x key দিয়ে চালানো হয়নি। KyberSwap এরটা লাইভ যাচাই হয়েছে।

ফি বদলাতে: Coolify তে `PLATFORM_FEE_BPS` ও `PLATFORM_FEE_RECIPIENT` বদলে `api` redeploy।

---

## ৩. Admin প্যানেল

Owner wallet কানেক্ট করলে হেডারে **Admin** ট্যাব আসে। অন্য কেউ ট্যাবটা দেখেই না। (এটা সুবিধা, নিরাপত্তা নয়: প্রতিটি কাজ কন্ট্রাক্ট কল, অন্য wallet এ revert করে।)

| নিয়ন্ত্রণ | কাজ | Timelock | ফেরানো যায়? |
| --- | --- | --- | --- |
| **Pause trading** | নতুন order, DCA ও execution বন্ধ। Cancel, refund, expiry চলে, কারো টাকা আটকায় না | নেই | হ্যাঁ (Resume) |
| **Minimum order size** | ছোট (dust) অর্ডার বন্ধ, 0 থেকে 10,000 USDC | নেই | হ্যাঁ |
| **Transfer ownership** | দুই ধাপ: আপনি offer দেন, নতুন owner accept করে। Renounce বন্ধ | নেই | accept এর আগে হ্যাঁ |
| **Lower keeper fee** | Keeper fee কমানো | নেই | **না** (স্থায়ী, বাড়ানো যায় না) |
| **Queue token feed** | নতুন টোকেন + price feed + max staleness (60 থেকে 172,800 সেকেন্ড) | হ্যাঁ (testnet 1 ঘণ্টা, mainnet এ 48 ঘণ্টা+) | Apply এর আগে Cancel |
| **Queue swap router** | রাউটার allow / revoke | হ্যাঁ | Apply এর আগে Cancel |
| **Disable now** (token / router) | তাৎক্ষণিক বন্ধ | নেই | আবার queue করে |
| **Backend status** | Keeper, gas balance, provider breaker, indexer lag | n/a | n/a |

Admin কী পারে না: ইউজারের escrow নিতে বা আটকাতে, refund আটকাতে, কন্ট্রাক্ট আপগ্রেড করতে, keeper fee বাড়াতে, order এ swap fee বসাতে।

নিয়ম: শুধু audited aggregator router allow করুন। কোনো টোকেন বা এমন কন্ট্রাক্ট কখনো swap target করবেন না যার orders কন্ট্রাক্টের উপর ক্ষমতা আছে।

**Backend status** এ `ADMIN_TOKEN` পেস্ট করে Load চাপুন। টোকেনটি শুধু ওই ট্যাবে থাকে, শুধু আপনার backend এ যায়।

Admin এর টোকেন/রাউটার তালিকা ও pending change দেখতে **indexer চালু** (`INDEXER_ENABLED=true`) থাকতে হয়।

---

## ৪. লোকালি চালানো

আগে একবার: `bun install` (Windows এ PATH এর `bun` ভাঙা থাকলে `~/.bun/bin/bun` ব্যবহার করুন)।

```bash
bun run dev                 # frontend, localhost:5173
bun run server              # backend, localhost:3001 (keeper চালু করতে .env তে KEEPER_ENABLED=true)
```

`.env` (লোকাল) এ কমপক্ষে: `VITE_ORDERS_ADDRESS_ARC_TESTNET`, `KEEPER_PRIVATE_KEY`, `KEEPER_ENABLED=true`, `ADMIN_TOKEN`।

### টেস্ট

```bash
bun test                    # 114 টেস্ট (PATH এ আসল bun থাকতে হবে)
bun run contracts:test      # 191 Foundry টেস্ট
bun run typecheck && bun run lint
```

### যা লাইভ টেস্ট করা হয়েছে (Arc Testnet, ব্রাউজারে, টেস্ট wallet দিয়ে)

- Market swap (approve + swap), stop-loss তৈরি ও keeper এর fill, DCA তৈরি/pause/resume/cancel (refund সহ), OCO তৈরি/cancel।
- Admin: owner wallet এ Admin ট্যাব আসে, pause → resume, router change queue → cancel (লাইভ transaction), pending list ও countdown।
- Mainnet UI: ৫৯ টোকেনের সার্চ, ARCMAN এর লাইভ quote ও 0.30% platform fee সারি।
- সম্পূর্ণ লাইভ e2e (আগের রান): 14/14 ও security 8/8, রিপোর্ট `docs/test-reports/README.md`।

---

## ৫. Coolify তে ডেপ্লয় (Docker Compose)

ফাইল: `Dockerfile`, `docker-compose.yml`, `deploy/nginx.conf`, `scripts/coolify/gen-env.ts`, `scripts/coolify/preflight.ts`।

দুটি সার্ভিস: **web** (nginx, পাবলিক, পোর্ট 80) এবং **api** (Bun: quote gateway + keeper + indexer + admin status, ইন্টারনাল)। **api এর একটাই কপি চালান**: keeper ও indexer এ state আছে, দুটো চালালে একই অর্ডারে race হবে।

### ধাপ ১: `.env` বানান

```bash
bun run scripts/coolify/gen-env.ts --new-keeper-key
```

এটা `deploy/coolify/production.env` লেখে (git-ignored): র‍্যান্ডম 64 অক্ষরের `ADMIN_TOKEN`, নতুন keeper wallet (ঠিকানা প্রিন্ট করে), লোকাল `.env` থেকে পাবলিক মান, বাকি সব ডিফল্ট ও কমেন্ট সহ। Mainnet ডিফল্টের জন্য `--mainnet`, নতুন করে লিখতে `--force` (এতে admin token বদলে যায়)।

তারপর:
1. **Keeper wallet এ gas এর জন্য কিছু USDC পাঠান** (testnet: Circle faucet)।
2. ফাইলে `ALLOWED_ORIGINS=https://আপনার-ডোমেইন` দিন। Swap fee চাইলে `PLATFORM_FEE_BPS` ও `PLATFORM_FEE_RECIPIENT` দিন।
3. যাচাই:

```bash
bun run scripts/coolify/preflight.ts deploy/coolify/production.env
```

Preflight দেখে: RPC ঠিক নেটওয়ার্কের কি না, order কন্ট্রাক্টে কোড আছে কি না ও owner কে, keeper এ gas আছে কি না, keeper key owner key নয় তো, fee সেটিং ঠিক কি না। সমস্যা থাকলে exit code 1।

### ধাপ ২: Coolify তে রিসোর্স

1. **Project → New resource → Docker Compose** (Git repository থেকে)। ব্রাঞ্চ `main`, compose ফাইল `/docker-compose.yml`।
2. **Environment Variables → Developer view** এ `production.env` এর পুরো কনটেন্ট পেস্ট করুন। `ADMIN_TOKEN` বাধ্যতামূলক, না থাকলে ডেপ্লয় থামবে।
3. `VITE_*` ভ্যারিয়েবল **Build variable** হিসেবে মার্ক করুন (Coolify তে অপশন থাকলে)। এগুলো web image বানানোর সময় ঢোকে।
4. **web** সার্ভিসে Domain দিন, যেমন `https://terminal.example.com:80`। **api** তে ডোমেইন দেবেন না।
5. `api-data` volume রাখুন (indexer ডাটাবেস)। না রাখলে প্রতি ডেপ্লয়ে history চেইন থেকে নতুন করে পড়তে হয়।
6. **Deploy**।

### ধাপ ৩: যাচাই

1. ডোমেইন খুলুন: অ্যাপ লোড হবে।
2. `https://ডোমেইন/api/health` → `"ok": true`।
3. Owner wallet কানেক্ট করুন → **Admin** ট্যাব → Backend status এ `ADMIN_TOKEN` দিন → keeper running, gas balance, provider ও indexer দেখুন।
4. Testnet এ ছোট stop-loss বানিয়ে (Testnet tools থেকে টোকেন নিয়ে, price নামিয়ে) keeper এর fill দেখুন।

### `.env` ভ্যারিয়েবল

| ভ্যারিয়েবল | লাগবে? | কাজ |
| --- | --- | --- |
| `ADMIN_TOKEN` | **হ্যাঁ** | Operator endpoint এর টোকেন, কমপক্ষে 24 অক্ষর |
| `VITE_DEFAULT_NETWORK` | না (`arc-testnet`) | নতুন ভিজিটর কোন নেটওয়ার্কে খুলবে: `arc` / `arc-testnet` |
| `KEEPER_NETWORK`, `INDEXER_NETWORK` | না | keeper ও indexer কোন নেটওয়ার্ক দেখবে (ডিফল্ট নেটওয়ার্কের সমান রাখুন) |
| `VITE_ORDERS_ADDRESS_ARC_TESTNET`, `VITE_ORDERS_DEPLOY_TX_ARC_TESTNET` | testnet order এ | কন্ট্রাক্ট ও ডেপ্লয় tx |
| `VITE_ORDERS_ADDRESS_ARC_MAINNET`, `VITE_ORDERS_DEPLOY_TX_ARC_MAINNET` | mainnet order এ | আপনি mainnet এ ডেপ্লয়ের পর |
| `VITE_SWAP_TARGETS_ARC` | না | mainnet এ অতিরিক্ত যাচাইকৃত রাউটার |
| `KEEPER_ENABLED` | না (`true`) | `api` এর ভেতরে keeper চালায় |
| `KEEPER_PRIVATE_KEY` | keeper চালু থাকলে | আলাদা, কম ব্যালেন্সের wallet। **কখনো owner key নয়** |
| `PLATFORM_FEE_BPS`, `PLATFORM_FEE_RECIPIENT` | না (`0`) | swap fee (সর্বোচ্চ 100 = 1%) ও recipient |
| `GATEWAY_PROVIDERS` | না | quote provider। ডিফল্টে testnet রাউটার ও 0x, kyber। Testnet রাউটার mainnet এ উত্তর দেয় না |
| `ZEROEX_API_KEY` | না | mainnet এ 0x যোগ করে। KyberSwap এ key লাগে না |
| `RPC_URL_Arc`, `RPC_URL_Arc_Testnet` | না | কমা দিয়ে RPC লিস্ট (failover)। খালি = public RPC |
| `KEEPER_WS_URL` | না | নতুন order এ keeper সঙ্গে সঙ্গে জাগে |
| `INDEXER_ENABLED`, `INDEXER_INTERVAL_MS`, `DATABASE_URL` | না | ডিফল্টে চালু, volume এ SQLite। Postgres সম্ভব, তবে SQLite টেস্ট করা পথ |
| `TRUSTED_PROXY_HOPS` | না (`2`) | ইন্টারনেট আর api এর মাঝে প্রক্সি সংখ্যা: Coolify proxy + nginx = 2, Cloudflare থাকলে 3 |
| `ALLOWED_ORIGINS` | সুপারিশ | আপনার পাবলিক origin, অন্য সাইট আপনার quote সার্ভিস ব্যবহার আটকায় |
| `ALERT_WEBHOOK_URL` | না | keeper / provider অ্যালার্ট ওয়েবহুক |

`VITE_*` তে কোনো secret দেবেন না: ওগুলো পাবলিক JS bundle এ ঢোকে।

### রক্ষণাবেক্ষণ

- **আপডেট:** ব্রাঞ্চে push করলে Coolify rebuild করে। `VITE_*` বদলালে web rebuild লাগে।
- **Admin token বদল:** `ADMIN_TOKEN` বদলে `api` redeploy।
- **Keeper key বদল:** আগে নতুন wallet এ gas দিন, তারপর বদলান। যেকোনো wallet অর্ডার execute করতে পারে, তাই অর্ডার প্রভাবিত হয় না।
- **জরুরি:** Admin → Pause trading (owner wallet লাগে)। Refund ও cancel চলতে থাকে।
- **ব্যাকআপ:** শুধু `api-data` volume। চেইন থেকে আবার বানানো যায়।

### সমস্যা সমাধান

| লক্ষণ | কারণ | সমাধান |
| --- | --- | --- |
| ডেপ্লয় "set ADMIN_TOKEN" এ থামে | বাধ্যতামূলক ভ্যারিয়েবল নেই | Environment এ যোগ করুন |
| "Quote service offline" | `api` unhealthy বা `/api` প্রক্সি হচ্ছে না | `api` লগ ও `/api/health` দেখুন |
| সবাই 429 পায় | প্রক্সির পেছনে `TRUSTED_PROXY_HOPS=0` | `2` দিন |
| Order fill হয় না | keeper বন্ধ, gas নেই | Admin → Backend status, keeper এ USDC দিন |
| Admin ট্যাব নেই | connected wallet owner নয় | Owner wallet কানেক্ট করুন |
| মেইননেটে টোকেন লিস্ট খালি | কনটেইনার থেকে KyberSwap রেজিস্ট্রিতে পৌঁছানো যাচ্ছে না | আউটবাউন্ড HTTPS দেখুন |

---

## ৬. Mainnet এ যাওয়ার আগে (এখনো করা হয়নি, আপনার কাজ)

বিস্তারিত: `docs/mainnet-readiness-checklist.md`। সংক্ষেপে বাকি আছে:

1. **স্বাধীন অডিট** (blocker)। v2 কন্ট্রাক্ট unaudited।
2. **Oracle পরিকল্পনা:** Chainlink feed এর heartbeat 24 ঘণ্টা, stop-loss পিছিয়ে থাকা দামে চলতে পারে।
3. **Real aggregator calldata** দিয়ে fork টেস্ট (Arc এর Foundry fork লাগবে)।
4. **Owner = multisig**, config delay কমপক্ষে 48 ঘণ্টা, keeper key KMS এ।
5. **0x key** দিয়ে fee টেস্ট, fee recipient multisig / cold wallet।
6. Mainnet প্যারামিটারে টেস্টনেটে আরেকবার পুরো রিহার্সাল, তারপর সীমিত cap দিয়ে লঞ্চ।

Mainnet এ কোনো ডেপ্লয় বা ট্রেড এই কাজে করা হয়নি।
