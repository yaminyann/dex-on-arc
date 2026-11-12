/**
 * The conversational layer in front of the command grammar. It costs nothing to run: no network call, no model.
 *
 * It does three things:
 *  1. Reads plain wording ("sell half my bitcoin if it falls to 80k") and rewrites it into one command of the
 *     fixed grammar. The rewrite is shown to the user, and the normal parser, plan, readback and wallet
 *     confirmation still follow. Nothing here can send a transaction.
 *  2. Answers questions about the order types and the agent from a fixed set of explanations.
 *  3. Suggests setups from what the user holds, using simple risk rules. These are not forecasts.
 *
 * Anything it cannot read returns `none`, and the caller may then ask an optional language model, which is
 * held to the same rule: it may only produce text that the strict parser accepts.
 */
import { parseCommand, type Intent } from './parser'

export interface ChatToken {
  symbol: string
  name: string
}

export interface Holding {
  symbol: string
  /** Wallet balance plus anything escrowed, in whole tokens. */
  amount: number
  /** Oracle price in the quote currency, or null when the token has no feed. */
  price: number | null
}

export interface ChatContext {
  tokens: ChatToken[]
  quote: string
  connected: boolean
  holdings: Holding[]
  /** Oracle price per tradable token symbol, in the quote currency. */
  prices: Record<string, number>
  /** Free quote currency in the wallet (USDC). */
  freeQuote: number
  /** Tokens that already have an open stop-loss, OCO, trailing or stop-limit order. */
  protectedSymbols: string[]
  activeDca: number
}

export interface Suggestion {
  label: string
  command: string
  why: string
  /** `fill` puts the command in the input so the user can edit numbers; `run` sends it for a readback. */
  mode: 'run' | 'fill'
}

export type ChatResult =
  | { kind: 'command'; command: string; note: string }
  | { kind: 'reply'; text: string; suggestions?: Suggestion[] }
  | { kind: 'none' }

// ---------- small helpers ----------

/** A price printed so it reads naturally at any size, with no thousands separators (the parser wants plain numbers). */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return String(Math.round(n))
  if (n >= 1) return String(Number(n.toFixed(2)))
  return String(Number(n.toPrecision(4)))
}

const fmtAmount = (n: number) => String(Number(n.toFixed(6)))
const usd = (n: number) => String(Math.floor(n * 100) / 100)

const ALIASES: Record<string, string> = { bitcoin: 'btc', btc: 'btc', wbtc: 'btc', xbt: 'btc', ether: 'eth', ethereum: 'eth', eth: 'eth', weth: 'eth', solana: 'sol', sol: 'sol', euro: 'eurc', eur: 'eurc' }

/** Finds the listed token a word refers to: by symbol, by common name (bitcoin, ether), or by a unique name match. */
export function resolveTokenWord(word: string, tokens: ChatToken[]): ChatToken | null {
  const w = word.toLowerCase()
  const exact = tokens.find((t) => t.symbol.toLowerCase() === w)
  if (exact) return exact
  const base = ALIASES[w] ?? w
  const named = tokens.find((t) => {
    const s = t.symbol.toLowerCase()
    return s === base || s === `t${base}` || s === `c${base}` || s.replace(/^[tc]/, '') === base
  })
  if (named) return named
  if (w.length >= 4) {
    const byName = tokens.filter((t) => t.name.toLowerCase().split(/\s+/).includes(w))
    if (byName.length === 1) return byName[0]
  }
  return null
}

const BUY_WORDS = new Set(['buy', 'purchase', 'get', 'accumulate', 'invest', 'long', 'grab', 'stack'])
const SELL_WORDS = new Set(['sell', 'dump', 'exit', 'offload', 'liquidate', 'close'])
const PROTECT_WORDS = new Set(['protect', 'safeguard', 'secure', 'hedge', 'insure', 'stoploss', 'sl'])
const DOWN_WORDS = new Set(['drops', 'drop', 'falls', 'fall', 'dips', 'dip', 'below', 'under', 'crashes', 'decline', 'declines', 'down', 'lower'])
const UP_WORDS = new Set(['rises', 'rise', 'pumps', 'pump', 'above', 'over', 'reaches', 'reach', 'hits', 'hit', 'target', 'up', 'higher', 'exceeds', 'climbs'])
const PRICE_PREPS = new Set(['at', 'to', 'below', 'under', 'above', 'over', 'reaches', 'reach', 'hits', 'hit', 'target', 'around', 'near', 'than', 'exceeds', 'of'])
const QUOTE_NOUNS = new Set(['usdc'])
const DURATION: Record<string, number> = { day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30 }
const ALL_WORDS = new Set(['all', 'everything', 'whole', 'entire', 'full'])

function prep(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d),(?=\d{3})/g, '$1')
    .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_m, n: string) => String(Number(n) * 1000))
    .replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1 usdc ')
    .replace(/\b(dollars?|bucks?|usd|usdt|usdc)\b/g, 'usdc')
    .replace(/(\d)\s*(%|percent|pct)/g, '$1%')
    .replace(/\b(a|an|one)\s+(day|week|month)\b/g, '1 $2')
    .replace(/stop[\s_-]*loss/g, 'stoploss')
    .replace(/take[\s_-]*profit/g, 'takeprofit')
    .replace(/trailing[\s_-]*stop|trail\b/g, 'trailing')
    .replace(/[^\w.%@\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Slots {
  words: string[]
  token: ChatToken | null
  tokenWord: string | null
  usdc: number | null
  tokenAmount: number | null
  pcts: number[]
  prices: number[]
  days: number | null
  all: boolean
  half: boolean
}

function readSlots(text: string, tokens: ChatToken[]): Slots {
  const words = prep(text).split(' ').filter(Boolean)
  const s: Slots = { words, token: null, tokenWord: null, usdc: null, tokenAmount: null, pcts: [], prices: [], days: null, all: false, half: false }
  for (const w of words) {
    if (/^\d/.test(w) || QUOTE_NOUNS.has(w) || BUY_WORDS.has(w) || SELL_WORDS.has(w)) continue
    const t = resolveTokenWord(w, tokens)
    if (t && !s.token) {
      s.token = t
      s.tokenWord = w
    }
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (ALL_WORDS.has(w)) s.all = true
    if (w === 'half') s.half = true
    if (!/^\d+(?:\.\d+)?%?$/.test(w)) continue
    const prev = words[i - 1] ?? ''
    const next = words[i + 1] ?? ''
    if (w.endsWith('%')) {
      s.pcts.push(Number(w.slice(0, -1)))
      continue
    }
    const n = Number(w)
    if (PRICE_PREPS.has(prev) && !(prev === 'of' && QUOTE_NOUNS.has(next))) s.prices.push(n)
    else if (next in DURATION) s.days = (s.days ?? 0) + n * DURATION[next]
    else if (QUOTE_NOUNS.has(next) || QUOTE_NOUNS.has(prev)) s.usdc ??= n
    else if (resolveTokenWord(next, tokens)) s.tokenAmount ??= n
    else if (prev === 'for' || next === 'times') s.days ??= n
  }
  return s
}

const has = (words: string[], set: Set<string>) => words.some((w) => set.has(w))

function frequency(words: string[]): 'hourly' | 'daily' | 'weekly' | 'monthly' | null {
  const t = words.join(' ')
  if (/\b(hourly|every hour|each hour|per hour)\b/.test(t)) return 'hourly'
  if (/\b(daily|every day|each day|per day|everyday)\b/.test(t)) return 'daily'
  if (/\b(weekly|every week|each week|per week)\b/.test(t)) return 'weekly'
  if (/\b(monthly|every month|each month|per month)\b/.test(t)) return 'monthly'
  return null
}

// ---------- fixed explanations ----------

interface Topic {
  match: RegExp
  title: string
  text: string
  example: string
}

const TOPICS: Topic[] = [
  {
    match: /stoploss|stop loss/,
    title: 'Stop-loss',
    text: 'A stop-loss sells your token when the price falls to a level you choose, to limit a loss. Here it is an escrowed order: the tokens sit in the contract until a keeper fills it. It follows the contract oracle, which can lag the market, and a triggered order is not guaranteed to fill.',
    example: 'stop loss 0.001 tBTC at 80000',
  },
  {
    match: /takeprofit|take profit/,
    title: 'Take-profit',
    text: 'A take-profit sells when the price rises to your target, so a gain is locked in without watching the screen. Same mechanics as a stop-loss: escrow, oracle price, keeper.',
    example: 'take profit 0.001 tBTC at 100000',
  },
  {
    match: /trailing/,
    title: 'Trailing stop',
    text: 'A trailing stop follows the highest price by a percentage you choose. If the price rises the stop rises with it; if it falls by that percentage the order triggers. A keeper has to record each new high, so it can lag.',
    example: 'trailing stop 0.001 tBTC 5%',
  },
  {
    match: /\boco\b|one cancels/,
    title: 'OCO',
    text: 'OCO is one escrow with two exits: a stop-loss below and a take-profit above. Whichever price is hit first runs and the other can never run.',
    example: 'oco 0.001 tBTC sl 80000 tp 100000',
  },
  {
    match: /\bdca\b|dollar cost|recurring|averag/,
    title: 'DCA',
    text: 'DCA buys a fixed amount on a schedule (hourly, daily, weekly or monthly) instead of all at once, so you do not depend on one price. The budget is escrowed up front; you can pause, resume or cancel and take back what is left. An optional price cap skips buys above it.',
    example: 'dca 1 USDC into tBTC daily for 7 days',
  },
  {
    match: /\blimit\b/,
    title: 'Limit order',
    text: 'A limit order waits for your price. A limit buy spends your USDC only when the price is at or below the level; a limit sell sells your token only at or above it. It is escrowed until a keeper fills it or you cancel.',
    example: 'limit buy tBTC 5 USDC at 70000',
  },
  {
    match: /slippage/,
    title: 'Slippage',
    text: 'Slippage is how much worse than the quote you accept. The readback shows the minimum you will receive, and the router rejects the swap if the output is lower. The default comes from Settings > Trading.',
    example: 'buy 10 USDC of tBTC',
  },
  {
    match: /keeper/,
    title: 'Keepers',
    text: 'A keeper is any wallet that calls execute on an order whose condition is met. It earns a small fee (at most 0.10% of the output, and the owner can only lower it). Orders do not run if no keeper is running.',
    example: 'orders',
  },
  {
    match: /\bfees?\b|cost|charge/,
    title: 'Fees',
    text: 'Orders pay a keeper fee of at most 0.10% of the output when they fill. Market swaps may carry a small platform fee set by the operator; it is a line in the readback before you confirm. Gas is paid in USDC.',
    example: 'buy 10 USDC of tBTC',
  },
  {
    match: /safe|custody|trust|rug|audit|hack|secure/,
    title: 'Safety',
    text: 'Non-custodial: market swaps go from your wallet through an aggregator router, and orders are escrowed in a contract that only you can cancel. The contract is unaudited, the oracle can lag, and your wallet approves every transaction. Size your risk accordingly.',
    example: 'balance',
  },
  {
    match: /permission|grant|allow|limits?\b/,
    title: 'Permission',
    text: 'You grant the agent permission once, with a duration, a largest command, a daily total and which actions it may take. It never sees a key and your wallet still signs every transaction. Revoke any time on the right.',
    example: 'help',
  },
  {
    match: /\bai\b|llm|chatgpt|model|bot|how do you work|are you/,
    title: 'How I work',
    text: 'I read your message with fixed rules first, which costs nothing and always gives the same answer. If the operator has switched on a language model, wording the rules cannot read may be sent to it. Either way I can only produce a command from the fixed grammar. It is read back with exact numbers, and nothing is sent until you say yes and your wallet signs.',
    example: 'help',
  },
]

const CAPABILITIES = 'I can swap at market, set limit, stop-loss, take-profit, trailing and OCO orders, run a DCA, cancel or pause things, show your balance, orders and prices, and suggest setups from what you hold. Write it in your own words or use a command.'

// ---------- suggestions ----------

/** Setups from simple risk rules on what the user holds. They are not predictions. */
export function buildSuggestions(ctx: ChatContext): { text: string; suggestions: Suggestion[] } {
  const q = ctx.quote
  const first = ctx.tokens[0]
  if (!ctx.connected) {
    const sym = first?.symbol ?? 'tBTC'
    return {
      text: 'Connect your wallet and I can base ideas on what you hold. Until then, here are common setups with sample numbers. Tap one to put it in the box and change the numbers.',
      suggestions: [
        { label: 'Spread a buy over a week', command: `dca 1 ${q} into ${sym} daily for 7 days`, why: 'Buys a little each day instead of all at one price.', mode: 'fill' },
        { label: 'Buy only on a dip', command: `limit buy ${sym} 5 ${q} at 70000`, why: 'Spends your USDC only if the price falls to your level.', mode: 'fill' },
        { label: 'Protect a position', command: `oco 0.001 ${sym} sl 80000 tp 100000`, why: 'One escrow with a stop-loss below and a take-profit above.', mode: 'fill' },
      ],
    }
  }
  const out: Suggestion[] = []
  const priced = ctx.holdings.filter((h) => h.price !== null && h.amount * (h.price ?? 0) >= 1)
  for (const h of priced) {
    if (out.length >= 3) break
    if (ctx.protectedSymbols.includes(h.symbol)) continue
    const p = h.price as number
    const sl = fmtPrice(p * 0.95)
    const tp = fmtPrice(p * 1.1)
    out.push({
      label: `Protect your ${h.symbol} with an OCO`,
      command: `oco all ${h.symbol} sl ${sl} tp ${tp}`,
      why: `You hold about ${fmtAmount(h.amount)} ${h.symbol} (price ${fmtPrice(p)}) with no stop. This sells if the price falls 5% to ${sl} or rises 10% to ${tp}, whichever comes first. The tokens are held in the contract until it runs or you cancel.`,
      mode: 'run',
    })
    if (out.length < 3) {
      out.push({
        label: `Trail ${h.symbol} by 5%`,
        command: `trailing stop all ${h.symbol} 5%`,
        why: `The stop rises with the highest price and sells if it drops 5% from that high. It lets a gain run, but a keeper must record each new high.`,
        mode: 'run',
      })
    }
  }
  const target = priced[0]?.symbol ?? first?.symbol
  const targetPrice = (target ? ctx.prices[target] : undefined) ?? null
  if (target && ctx.freeQuote >= 5 && ctx.activeDca === 0) {
    const per = Math.floor(((ctx.freeQuote * 0.5) / 7) * 100) / 100
    if (per >= 0.5) {
      out.push({
        label: `DCA into ${target} for a week`,
        command: `dca ${usd(per)} ${q} into ${target} daily for 7 days`,
        why: `Spreads ${usd(per * 7)} ${q} of buying over 7 days (half of your free ${usd(ctx.freeQuote)} ${q}) instead of one price.`,
        mode: 'run',
      })
    }
  }
  if (target && targetPrice && ctx.freeQuote >= 5 && out.length < 4) {
    const amt = Math.floor(ctx.freeQuote * 0.3 * 100) / 100
    out.push({
      label: `Buy ${target} on a 3% dip`,
      command: `limit buy ${target} ${usd(amt)} ${q} at ${fmtPrice(targetPrice * 0.97)}`,
      why: `Buys only if ${target} falls 3% from ${fmtPrice(targetPrice)}. Your ${usd(amt)} ${q} is escrowed until it fills or you cancel.`,
      mode: 'run',
    })
  }
  if (out.length === 0) {
    return {
      text: ctx.holdings.length === 0 && ctx.freeQuote < 1 ? `You have no ${q} or tokens on this network yet. On testnet, the faucet tool gives you test funds. Then ask me again.` : 'Nothing stands out from simple rules right now: your tokens already have stops, or the amounts are very small. You can still ask for any order in your own words.',
      suggestions: [],
    }
  }
  return {
    text: 'Here are setups based on what you hold. They come from simple risk rules, not predictions, and are not financial advice. Tap one and I will read the exact terms back before anything is sent.',
    suggestions: out.slice(0, 4),
  }
}

// ---------- reading a message ----------

function explain(topic: Topic): ChatResult {
  return {
    kind: 'reply',
    text: `${topic.title}. ${topic.text}`,
    suggestions: [{ label: `Try: ${topic.example}`, command: topic.example, why: 'Sample numbers. Change them before sending.', mode: 'fill' }],
  }
}

function ask(text: string, example?: string): ChatResult {
  return { kind: 'reply', text, suggestions: example ? [{ label: example, command: example, why: 'Edit the numbers, then send.', mode: 'fill' }] : undefined }
}

const done = (command: string, note?: string): ChatResult => {
  const parsed = parseCommand(command)
  if (!parsed.ok) return { kind: 'none' }
  return { kind: 'command', command, note: note ? `I read that as: ${command}. ${note}` : `I read that as: ${command}` }
}

/** Rewrites a plain-words trading request into a command, or asks for what is missing. */
function composeAction(s: Slots, ctx: ChatContext, price: (sym: string) => number | null): ChatResult | null {
  const w = s.words
  const buy = has(w, BUY_WORDS)
  const sell = has(w, SELL_WORDS)
  const protect = has(w, PROTECT_WORDS)
  const trailing = w.includes('trailing')
  const freq = frequency(w)
  const down = has(w, DOWN_WORDS)
  const up = has(w, UP_WORDS)
  if (!buy && !sell && !protect && !trailing && !freq) return null

  // Management commands are left to the strict parser; this layer only reads trades.
  let tok = s.token
  if (!tok && ctx.tokens.length === 1) tok = ctx.tokens[0]
  if (!tok) return ask(`Which token? I can use: ${ctx.tokens.slice(0, 6).map((t) => t.symbol).join(', ')}${ctx.tokens.length > 6 ? ', ...' : ''}.`)
  const sym = tok.symbol
  const cur = price(sym)
  const q = ctx.quote

  const sellAmount = (): string | null => {
    if (s.all) return 'all'
    if (s.half) return '50%'
    if (s.tokenAmount !== null) return fmtAmount(s.tokenAmount)
    if (s.pcts.length > 0 && !trailing && (s.prices.length > 0 || !(down || up))) return `${s.pcts[0]}%`
    return null
  }

  // DCA
  if (freq) {
    if (s.usdc === null) return ask(`How much ${q} should each buy spend? For example: dca 2 ${q} into ${sym} ${freq} for 7 days`)
    if (s.days === null || s.days < 1) return ask(`For how long? For example: dca ${s.usdc} ${q} into ${sym} ${freq} for 7 days`)
    const cap = s.prices.length > 0 && (down || w.includes('cap') || w.includes('max')) ? ` cap ${s.prices[0]}` : ''
    return done(`dca ${s.usdc} ${q} into ${sym} ${freq} for ${Math.round(s.days)} days${cap}`)
  }

  // Trailing stop
  if (trailing) {
    const pct = s.pcts[s.pcts.length - 1]
    if (pct === undefined) return ask('How far behind the highest price should the stop trail? For example 5%.', `trailing stop all ${sym} 5%`)
    return done(`trailing stop ${sellAmount() ?? 'all'} ${sym} ${pct}%`)
  }

  // A percentage move from the current price, when the price is known: "if it drops 5%".
  let prices = [...s.prices]
  if (prices.length === 0 && s.pcts.length > 0 && cur !== null && (down || up)) {
    prices = [down ? cur * (1 - s.pcts[0] / 100) : cur * (1 + s.pcts[0] / 100)].map((p) => Number(fmtPrice(p)))
  }

  // Sell side: stop-loss, take-profit, OCO, limit sell, market sell.
  if (sell || protect) {
    const amt = sellAmount() ?? (protect ? 'all' : null)
    if (prices.length >= 2) {
      const [lo, hi] = [Math.min(...prices.slice(0, 2)), Math.max(...prices.slice(0, 2))]
      return done(`oco ${amt ?? 'all'} ${sym} sl ${lo} tp ${hi}`)
    }
    if (prices.length === 1) {
      if (!amt) return ask(`How much ${sym}? You can say all, half, a percentage or an amount.`, `sell all ${sym} at ${prices[0]}`)
      const p = prices[0]
      const isStop = protect || (down && !up) || (!up && cur !== null && p < cur)
      if (isStop) return done(`stop loss ${amt} ${sym} at ${p}`)
      if (up && !down) return done(`take profit ${amt} ${sym} at ${p}`)
      return done(`limit sell ${amt} ${sym} at ${p}`)
    }
    if (protect) {
      if (cur === null) return ask(`At what price should the stop sell your ${sym}? For example: stop loss all ${sym} at 80000`, `stop loss all ${sym} at 80000`)
      const sl = fmtPrice(cur * 0.95)
      return {
        kind: 'reply',
        text: `${sym} is at ${fmtPrice(cur)} on the oracle. A common starting point is a stop 5% below, at ${sl}. Tell me your own level, or take this one and I will read it back.`,
        suggestions: [
          { label: `Stop-loss all ${sym} at ${sl}`, command: `stop loss all ${sym} at ${sl}`, why: 'Sells everything you hold if the price falls to this level.', mode: 'run' },
          { label: `OCO: ${sl} down, ${fmtPrice(cur * 1.1)} up`, command: `oco all ${sym} sl ${sl} tp ${fmtPrice(cur * 1.1)}`, why: 'A stop-loss and a take-profit in one escrow.', mode: 'run' },
        ],
      }
    }
    const a = amt
    if (!a) return ask(`How much ${sym} should I sell? You can say all, half, a percentage or an amount.`, `sell 50% of ${sym}`)
    return done(`sell ${a} ${sym}`)
  }

  // Buy side: limit buy or market buy.
  if (buy) {
    let spend = s.usdc
    let note: string | undefined
    if (spend === null && s.tokenAmount !== null && cur !== null) {
      spend = Math.ceil(s.tokenAmount * cur * 100) / 100
      note = `Market buys are sized in ${q}, so ${fmtAmount(s.tokenAmount)} ${sym} at the current ${fmtPrice(cur)} is about ${spend} ${q}.`
    }
    if (spend === null) return ask(`How much ${q} should I spend on ${sym}? For example: buy 10 ${q} of ${sym}`, `buy 10 ${q} of ${sym}`)
    if (prices.length >= 1) return done(`limit buy ${sym} ${spend} ${q} at ${prices[0]}`, note)
    return done(`buy ${spend} ${q} of ${sym}`, note)
  }
  return null
}

const QUESTION_START = /^(what|how|why|when|which|who|explain|tell me|define|difference|is |are |does |do |can i|should i|meaning)/
const SUGGEST = /\b(suggest|suggestion|suggestions|idea|ideas|recommend|recommendation|advice|advise|what should i|what can i do|what to do|help me trade|any trade|good trade|opportunit)/
const GREETING = /^(hi|hello|hey|hola|yo|salam|assalamu alaikum|assalamualaikum|good (morning|evening|afternoon)|namaste|kemon acho|ki khobor)\b/
const THANKS = /^(thanks|thank you|thx|ty|dhonnobad|shukriya)\b/

/** Understands one chat message. Returns `none` when the rules cannot read it. */
export function interpretChat(text: string, ctx: ChatContext): ChatResult {
  const raw = text.trim()
  if (!raw) return { kind: 'none' }
  const lower = raw.toLowerCase().replace(/\s+/g, ' ')
  const price = (sym: string) => ctx.prices[sym] ?? null

  if (GREETING.test(lower) && lower.split(' ').length <= 4) return { kind: 'reply', text: `Hello. ${CAPABILITIES}`, suggestions: [] }
  if (THANKS.test(lower)) return { kind: 'reply', text: 'Anytime. Ask for another setup, or type help for the full list.' }
  if (/^(what can you do|who are you|what are you|what do you do|capabilities)\b/.test(lower)) return { kind: 'reply', text: CAPABILITIES }

  if (SUGGEST.test(lower) && !/[0-9]/.test(lower)) {
    const s = buildSuggestions(ctx)
    return { kind: 'reply', text: s.text, suggestions: s.suggestions }
  }
  if (/^(suggest|recommend|ideas?)\b/.test(lower)) {
    const s = buildSuggestions(ctx)
    return { kind: 'reply', text: s.text, suggestions: s.suggestions }
  }

  const prepped = prep(raw)
  if (QUESTION_START.test(lower) || lower.endsWith('?')) {
    const topic = TOPICS.find((t) => t.match.test(prepped) || t.match.test(lower))
    // "can you buy 10 usdc of btc" is a request, not a question about buying.
    const slots = readSlots(raw, ctx.tokens)
    const looksLikeOrder = (slots.usdc !== null || slots.tokenAmount !== null || slots.prices.length > 0) && (has(slots.words, BUY_WORDS) || has(slots.words, SELL_WORDS) || slots.words.includes('dca'))
    if (topic && !looksLikeOrder) return explain(topic)
  }

  const slots = readSlots(raw, ctx.tokens)
  const action = composeAction(slots, ctx, price)
  if (action) return action

  // Look-ups in plain words.
  const w = slots.words
  if (/\b(balance|balances|portfolio|holdings|how much do i (have|own)|what do i (have|own)|my tokens|my wallet)\b/.test(lower)) return done('balance')
  if (/\b(my orders|open orders|my positions|my plans|orders i have|active orders)\b/.test(lower)) return done('orders')
  if (slots.token && (/\b(price|rate|worth|trading|quote|how much is)\b/.test(lower) || (w.length <= 3 && /\bprice\b/.test(lower)))) return done(`price ${slots.token.symbol}`)

  const topic = TOPICS.find((t) => t.match.test(prepped))
  if (topic && w.length <= 4) return explain(topic)
  return { kind: 'none' }
}

/**
 * Lets "buy 10 usdc of bitcoin" through the strict parser: if the typed token is not a listed symbol but is a
 * common name for exactly one listed token, the intent is changed to that symbol. Anything else is untouched.
 */
export function canonicalizeIntent<T extends Intent>(intent: T, tokens: ChatToken[]): T {
  if (!('token' in intent) || typeof intent.token !== 'string') return intent
  const name = intent.token
  if (/^0x[0-9a-fA-F]{40}$/.test(name)) return intent
  const hit = resolveTokenWord(name, tokens)
  return hit ? { ...intent, token: hit.symbol } : intent
}
