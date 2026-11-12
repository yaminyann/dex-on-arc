/**
 * Turns a typed command into a structured intent. No model is involved: the grammar is small, the same
 * text always gives the same result, and anything it cannot read is refused with an example instead of
 * being guessed. Token names stay as typed here; the engine resolves them against the real token list.
 */
export type Amount = { kind: 'usdc'; value: string } | { kind: 'token'; value: string } | { kind: 'percent'; value: number } | { kind: 'all' }
export type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly'
export type Side = 'buy' | 'sell'

export type Intent =
  | { kind: 'help' }
  | { kind: 'balance' }
  | { kind: 'orders' }
  | { kind: 'price'; token: string }
  | { kind: 'swap'; side: Side; token: string; amount: Amount }
  | { kind: 'limit'; side: Side; token: string; amount: Amount; price: string }
  | { kind: 'stop_loss'; token: string; amount: Amount; price: string }
  | { kind: 'take_profit'; token: string; amount: Amount; price: string }
  | { kind: 'stop_limit'; token: string; amount: Amount; stop: string; limit: string }
  | { kind: 'trailing'; token: string; amount: Amount; trailPct: string }
  | { kind: 'oco'; token: string; amount: Amount; stop: string; take: string }
  | { kind: 'dca'; token: string; perBuy: string; frequency: Frequency; days: number; cap?: string }
  | { kind: 'cancel_order'; id: number }
  | { kind: 'manage_dca'; action: 'pause' | 'resume' | 'cancel'; id: number }

export type ParseResult = { ok: true; intent: Intent } | { ok: false; error: string; example?: string }

export const EXAMPLES = {
  buy: 'buy 10 USDC of tBTC',
  sell: 'sell 50% of tBTC',
  limit: 'limit buy tBTC 5 USDC at 70000',
  stopLoss: 'stop loss 0.001 tBTC at 80000',
  takeProfit: 'take profit 0.001 tBTC at 100000',
  stopLimit: 'stop limit 0.001 tBTC stop 80000 limit 79000',
  trailing: 'trailing stop 0.001 tBTC 5%',
  oco: 'oco 0.001 tBTC sl 80000 tp 100000',
  dca: 'dca 1 USDC into tBTC daily for 7 days',
  cancel: 'cancel order 12',
  dcaManage: 'pause dca 3',
} as const

const FILLERS = new Set(['of', 'with', 'into', 'in', 'using', 'to', 'the', 'a', 'an', 'my', 'worth', 'on', 'per', 'each', 'please', 'now', 'market', 'token', 'tokens', 'coin', 'coins', 'some', 'just', 'me', 'i', 'want', 'wanna', 'would', 'like', 'can', 'you', 'could', 'kindly', 'and', 'then'])
const NUM = /^\d+(?:\.\d+)?$/
const PCT = /^\d+(?:\.\d+)?%$/
const SYMBOL = /^(?:[a-z][a-z0-9]{1,15}|0x[0-9a-f]{40})$/
const QUOTE_WORDS = new Set(['usdc', 'usd'])
const FREQ: Record<string, Frequency> = { hourly: 'hourly', hour: 'hourly', daily: 'daily', day: 'daily', weekly: 'weekly', week: 'weekly', monthly: 'monthly', month: 'monthly' }
const PRICE_MARKERS = new Set(['at', 'stop', 'limit', 'sl', 'tp', 'stoploss', 'takeprofit', 'target', 'cap', 'max', 'below', 'under', 'trail', 'by', 'distance'])
const RESERVED = new Set([
  ...PRICE_MARKERS,
  'for', 'every', 'days', 'weeks', 'months', 'buy', 'sell', 'dca', 'all', 'half', 'order', 'price', 'orders', 'plan', 'id',
  ...Object.keys(FREQ),
  ...QUOTE_WORDS,
])

function fail(error: string, example?: string): ParseResult {
  return { ok: false, error, example }
}

/** Lower-cases and unifies spellings, so "Stop-Loss", "stop loss" and "SL" read the same. */
export function normalize(text: string): string[] {
  const t = text
    .toLowerCase()
    // 95,000 is one number; $10 means 10 USDC.
    .replace(/(\d),(?=\d{3})/g, '$1')
    .replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1 usdc ')
    .replace(/[,$]/g, ' ')
    .replace(/@/g, ' at ')
    .replace(/stop[\s_-]*limit/g, 'stoplimit')
    .replace(/stop[\s_-]*loss/g, 'stoploss')
    .replace(/take[\s_-]*profit/g, 'takeprofit')
    .replace(/trailing[\s_-]*(?:stop)?/g, 'trailing ')
    .replace(/\bkino\b|\bpurchase\b/g, 'buy')
    .replace(/\bbecho\b/g, 'sell')
    .replace(/\bsl\b/g, 'stoploss')
    .replace(/\btp\b/g, 'takeprofit')
    .replace(/(\d)\s+%/g, '$1%')
    .replace(/[?!.;]+$/g, '')
  return t.split(/\s+/).filter((w) => w && !FILLERS.has(w))
}

interface Slots {
  /** marker -> the number that follows it (a price, a percent for trail, a duration). */
  marked: Map<string, string>
  /** word indexes that belong to a marker, so they are not read as the amount. */
  used: Set<number>
}

function readSlots(words: string[]): Slots {
  const marked = new Map<string, string>()
  const used = new Set<number>()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!PRICE_MARKERS.has(w) && w !== 'for') continue
    let j = i + 1
    if (QUOTE_WORDS.has(words[j] ?? '')) j++
    const v = words[j]
    if (v && (NUM.test(v) || PCT.test(v))) {
      // The first marker wins: "stop loss ... at 80000" must keep 80000 for stoploss, not for "at".
      if (!marked.has(w)) marked.set(w, v)
      used.add(j)
    }
  }
  return { marked, used }
}

interface Found {
  amount: Amount | null
  token: string | null
  /** True when more than one distinct token name or amount was typed. */
  conflict?: string
}

function findAmountAndToken(words: string[], slots: Slots, defaultUnit: 'usdc' | 'token'): Found {
  let amount: Amount | null = null
  let unitWord: string | null = null
  for (let i = 0; i < words.length && !amount; i++) {
    const w = words[i]
    if (slots.used.has(i)) continue
    if (w === 'all') amount = { kind: 'all' }
    else if (w === 'half') amount = { kind: 'percent', value: 50 }
    else if (PCT.test(w)) amount = { kind: 'percent', value: Number(w.slice(0, -1)) }
    else if (NUM.test(w)) {
      const next = words[i + 1]
      if (next && QUOTE_WORDS.has(next)) amount = { kind: 'usdc', value: w }
      else if (next && SYMBOL.test(next) && !RESERVED.has(next)) {
        amount = { kind: 'token', value: w }
        unitWord = next
      } else amount = defaultUnit === 'usdc' ? { kind: 'usdc', value: w } : { kind: 'token', value: w }
    }
  }
  // The token is the first real name that is not a keyword, a number or the quote currency.
  const names = words.filter((w, i) => !slots.used.has(i) && SYMBOL.test(w) && !RESERVED.has(w) && !NUM.test(w))
  const distinct = [...new Set(names)]
  if (distinct.length > 1) return { amount, token: distinct[0], conflict: `I read more than one token name (${distinct.join(', ')}). Use one token per command.` }
  return { amount, token: distinct[0] ?? unitWord }
}

function amountError(a: Amount | null, example: string): ParseResult | null {
  if (!a) return fail('I could not find an amount.', example)
  if (a.kind === 'percent' && !(a.value > 0 && a.value <= 100)) return fail('A percentage must be above 0 and at most 100.', example)
  if ((a.kind === 'usdc' || a.kind === 'token') && !(Number(a.value) > 0)) return fail('The amount must be above zero.', example)
  return null
}

function price(slots: Slots, keys: string[]): string | null {
  for (const k of keys) {
    const v = slots.marked.get(k)
    if (v && NUM.test(v) && Number(v) > 0) return v
  }
  return null
}

export function parseCommand(text: string): ParseResult {
  const words = normalize(text)
  if (words.length === 0) return fail('Type a command, for example: ' + EXAMPLES.buy)
  const verb = words[0]
  const rest = words.slice(1)
  const slots = readSlots(rest)

  switch (verb) {
    case 'help':
    case 'commands':
    case '?':
      return { ok: true, intent: { kind: 'help' } }
    case 'balance':
    case 'balances':
    case 'portfolio':
      return { ok: true, intent: { kind: 'balance' } }
    case 'orders':
    case 'positions':
      return { ok: true, intent: { kind: 'orders' } }
    case 'price':
    case 'quote': {
      const token = rest.find((w) => SYMBOL.test(w) && !RESERVED.has(w))
      return token ? { ok: true, intent: { kind: 'price', token } } : fail('Which token? For example: price tBTC')
    }

    case 'buy':
    case 'sell': {
      const f = findAmountAndToken(rest, slots, verb === 'buy' ? 'usdc' : 'token')
      if (f.conflict) return fail(f.conflict, verb === 'buy' ? EXAMPLES.buy : EXAMPLES.sell)
      if (!f.token) return fail('Which token?', verb === 'buy' ? EXAMPLES.buy : EXAMPLES.sell)
      const err = amountError(f.amount, verb === 'buy' ? EXAMPLES.buy : EXAMPLES.sell)
      if (err) return err
      const amount = f.amount!
      if (verb === 'buy' && amount.kind !== 'usdc') return fail('A market buy needs the USDC to spend, so the result is exact.', EXAMPLES.buy)
      if (verb === 'sell' && amount.kind === 'usdc') return fail('A market sell needs an amount of the token, a percentage, or "all".', EXAMPLES.sell)
      return { ok: true, intent: { kind: 'swap', side: verb, token: f.token, amount } }
    }

    case 'limit': {
      const side = rest[0]
      if (side !== 'buy' && side !== 'sell') return fail('Say whether it is a limit buy or a limit sell.', EXAMPLES.limit)
      const body = rest.slice(1)
      const s = readSlots(body)
      const f = findAmountAndToken(body, s, side === 'buy' ? 'usdc' : 'token')
      if (f.conflict) return fail(f.conflict, EXAMPLES.limit)
      if (!f.token) return fail('Which token?', EXAMPLES.limit)
      const err = amountError(f.amount, EXAMPLES.limit)
      if (err) return err
      const p = price(s, ['at', 'limit', 'below', 'under', 'target'])
      if (!p) return fail('A limit order needs a price: "at 70000".', EXAMPLES.limit)
      const amount = f.amount!
      if (side === 'buy' && amount.kind !== 'usdc') return fail('A limit buy needs the USDC to spend.', EXAMPLES.limit)
      if (side === 'sell' && amount.kind === 'usdc') return fail('A limit sell needs an amount of the token, a percentage, or "all".', 'limit sell 0.001 tBTC at 95000')
      return { ok: true, intent: { kind: 'limit', side, token: f.token, amount, price: p } }
    }

    case 'stoploss':
    case 'takeprofit': {
      const ex = verb === 'stoploss' ? EXAMPLES.stopLoss : EXAMPLES.takeProfit
      const f = findAmountAndToken(rest, slots, 'token')
      if (f.conflict) return fail(f.conflict, ex)
      if (!f.token) return fail('Which token?', ex)
      const err = amountError(f.amount, ex)
      if (err) return err
      if (f.amount!.kind === 'usdc') return fail('Stops sell the token, so give an amount of the token, a percentage, or "all".', ex)
      const p = price(slots, ['at', 'stop', 'target', 'stoploss', 'takeprofit'])
      if (!p) return fail('This needs a trigger price: "at 80000".', ex)
      return { ok: true, intent: verb === 'stoploss' ? { kind: 'stop_loss', token: f.token, amount: f.amount!, price: p } : { kind: 'take_profit', token: f.token, amount: f.amount!, price: p } }
    }

    case 'stoplimit': {
      const f = findAmountAndToken(rest, slots, 'token')
      if (f.conflict) return fail(f.conflict, EXAMPLES.stopLimit)
      if (!f.token) return fail('Which token?', EXAMPLES.stopLimit)
      const err = amountError(f.amount, EXAMPLES.stopLimit)
      if (err) return err
      if (f.amount!.kind === 'usdc') return fail('Stops sell the token, so give an amount of the token, a percentage, or "all".', EXAMPLES.stopLimit)
      const stop = price(slots, ['stop', 'at'])
      const limit = price(slots, ['limit'])
      if (!stop || !limit) return fail('A stop-limit needs both prices: "stop 80000 limit 79000".', EXAMPLES.stopLimit)
      return { ok: true, intent: { kind: 'stop_limit', token: f.token, amount: f.amount!, stop, limit } }
    }

    case 'trailing': {
      // A trailing stop has two percentages at most: the amount and the distance. The distance follows "trail" or "by", or is the last one.
      const pcts = rest.filter((w) => PCT.test(w))
      const marked = slots.marked.get('trail') ?? slots.marked.get('by') ?? slots.marked.get('distance')
      const trail = marked && PCT.test(marked) ? marked : pcts[pcts.length - 1]
      if (!trail) return fail('A trailing stop needs a distance: "5%".', EXAMPLES.trailing)
      const trailIdx = rest.lastIndexOf(trail)
      const used = new Set([...slots.used, trailIdx])
      const f = findAmountAndToken(rest, { marked: slots.marked, used }, 'token')
      if (f.conflict) return fail(f.conflict, EXAMPLES.trailing)
      if (!f.token) return fail('Which token?', EXAMPLES.trailing)
      const err = amountError(f.amount, EXAMPLES.trailing)
      if (err) return err
      if (f.amount!.kind === 'usdc') return fail('Stops sell the token, so give an amount of the token, a percentage, or "all".', EXAMPLES.trailing)
      const pct = Number(trail.slice(0, -1))
      if (!(pct >= 0.1 && pct <= 50)) return fail('The trailing distance must be between 0.1% and 50%.', EXAMPLES.trailing)
      return { ok: true, intent: { kind: 'trailing', token: f.token, amount: f.amount!, trailPct: trail.slice(0, -1) } }
    }

    case 'oco': {
      const f = findAmountAndToken(rest, slots, 'token')
      if (f.conflict) return fail(f.conflict, EXAMPLES.oco)
      if (!f.token) return fail('Which token?', EXAMPLES.oco)
      const err = amountError(f.amount, EXAMPLES.oco)
      if (err) return err
      if (f.amount!.kind === 'usdc') return fail('An OCO sells the token, so give an amount of the token, a percentage, or "all".', EXAMPLES.oco)
      const stop = price(slots, ['stoploss', 'stop'])
      const take = price(slots, ['takeprofit', 'target'])
      if (!stop || !take) return fail('An OCO needs both a stop-loss and a take-profit price.', EXAMPLES.oco)
      return { ok: true, intent: { kind: 'oco', token: f.token, amount: f.amount!, stop, take } }
    }

    case 'dca': {
      const f = findAmountAndToken(rest, slots, 'usdc')
      if (f.conflict) return fail(f.conflict, EXAMPLES.dca)
      if (!f.token) return fail('Which token?', EXAMPLES.dca)
      const err = amountError(f.amount, EXAMPLES.dca)
      if (err) return err
      if (f.amount!.kind !== 'usdc') return fail('A DCA plan spends USDC each time: "dca 1 USDC into tBTC daily for 7 days".', EXAMPLES.dca)
      const forIdx = rest.indexOf('for')
      // The unit after "for 7 days" is a duration, not the frequency.
      const freqWord = rest.find((w, i) => FREQ[w] && !(forIdx >= 0 && i === forIdx + 2))
      if (!freqWord) return fail('How often? hourly, daily, weekly or monthly.', EXAMPLES.dca)
      const durNum = forIdx >= 0 ? rest[forIdx + 1] : undefined
      if (!durNum || !NUM.test(durNum)) return fail('For how long? For example "for 7 days".', EXAMPLES.dca)
      const unit = rest[forIdx + 2] ?? 'days'
      const mult = /^week/.test(unit) ? 7 : /^month/.test(unit) ? 30 : 1
      const days = Number(durNum) * mult
      if (!Number.isInteger(days) || days < 1) return fail('The duration must be a whole number of days or more.', EXAMPLES.dca)
      const cap = price(slots, ['cap', 'max', 'below', 'under'])
      return { ok: true, intent: { kind: 'dca', token: f.token, perBuy: f.amount!.value, frequency: FREQ[freqWord], days, cap: cap ?? undefined } }
    }

    case 'cancel':
    case 'pause':
    case 'resume': {
      const target = rest.find((w) => w === 'order' || w === 'dca' || w === 'plan')
      const id = rest.find((w) => /^\d+$/.test(w))
      if (!id) return fail(`Which one? For example: ${verb === 'cancel' ? EXAMPLES.cancel : EXAMPLES.dcaManage}`)
      const n = Number(id)
      if (verb === 'cancel' && (target === 'order' || target === undefined)) return { ok: true, intent: { kind: 'cancel_order', id: n } }
      if (target === 'dca' || target === 'plan') return { ok: true, intent: { kind: 'manage_dca', action: verb, id: n } }
      return fail(`Say "${verb} order <id>" or "${verb} dca <id>".`, EXAMPLES.cancel)
    }

    default:
      return fail(`I do not know "${verb}". Type "help" to see what I understand.`, EXAMPLES.buy)
  }
}

/** The lines shown under "help". */
export const HELP_LINES: [string, string][] = [
  ['Market buy', EXAMPLES.buy],
  ['Market sell', EXAMPLES.sell + '  (or: sell all tBTC, sell 0.001 tBTC)'],
  ['Limit order', EXAMPLES.limit],
  ['Stop-loss', EXAMPLES.stopLoss],
  ['Take-profit', EXAMPLES.takeProfit],
  ['Stop-limit', EXAMPLES.stopLimit],
  ['Trailing stop', EXAMPLES.trailing],
  ['OCO', EXAMPLES.oco],
  ['DCA', EXAMPLES.dca + '  (optional: cap 90000)'],
  ['Cancel an order', EXAMPLES.cancel],
  ['Pause, resume or cancel a DCA', EXAMPLES.dcaManage],
  ['Look things up', 'price tBTC · balance · orders'],
]
