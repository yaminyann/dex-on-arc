import { describe, expect, test } from 'bun:test'
import { buildSuggestions, canonicalizeIntent, fmtPrice, interpretChat, resolveTokenWord, type ChatContext } from '../src/trading/agent/chat'
import { parseCommand } from '../src/trading/agent/parser'

const tokens = [
  { symbol: 'tBTC', name: 'Test Bitcoin' },
  { symbol: 'tETH', name: 'Test Ether' },
  { symbol: 'tSOL', name: 'Test Solana' },
]
const base: ChatContext = {
  tokens,
  quote: 'USDC',
  connected: true,
  holdings: [{ symbol: 'tBTC', amount: 0.01, price: 90000 }],
  prices: { tBTC: 90000, tETH: 3000, tSOL: 150 },
  freeQuote: 100,
  protectedSymbols: [],
  activeDca: 0,
}

function cmd(text: string, ctx = base): string {
  const r = interpretChat(text, ctx)
  if (r.kind !== 'command') throw new Error(`"${text}" gave ${r.kind}: ${r.kind === 'reply' ? r.text : ''}`)
  return r.command
}

describe('token names', () => {
  test('common names and symbols resolve to the listed token', () => {
    expect(resolveTokenWord('bitcoin', tokens)?.symbol).toBe('tBTC')
    expect(resolveTokenWord('BTC', tokens)?.symbol).toBe('tBTC')
    expect(resolveTokenWord('ethereum', tokens)?.symbol).toBe('tETH')
    expect(resolveTokenWord('solana', tokens)?.symbol).toBe('tSOL')
    expect(resolveTokenWord('tbtc', tokens)?.symbol).toBe('tBTC')
    expect(resolveTokenWord('banana', tokens)).toBeNull()
  })
})

describe('plain words become one command of the fixed grammar', () => {
  test('market buy', () => {
    expect(cmd('I want to buy bitcoin for 10 dollars')).toBe('buy 10 USDC of tBTC')
    expect(cmd('can you buy $25 of ether please')).toBe('buy 25 USDC of tETH')
  })
  test('market sell', () => {
    expect(cmd('sell half of my bitcoin')).toBe('sell 50% tBTC')
    expect(cmd('dump everything in solana')).toBe('sell all tSOL')
    expect(cmd('sell 0.002 btc')).toBe('sell 0.002 tBTC')
  })
  test('stop-loss from a level or a percentage of the current price', () => {
    expect(cmd('sell half my bitcoin if it falls to 80k')).toBe('stop loss 50% tBTC at 80000')
    expect(cmd('protect all my btc at 85000')).toBe('stop loss all tBTC at 85000')
    expect(cmd('sell all bitcoin if it drops 10%')).toBe('stop loss all tBTC at 81000')
  })
  test('take-profit, limit and OCO', () => {
    expect(cmd('sell all btc when it reaches 100k')).toBe('take profit all tBTC at 100000')
    expect(cmd('buy 20 dollars of bitcoin when it drops to 70000')).toBe('limit buy tBTC 20 USDC at 70000')
    expect(cmd('sell all bitcoin if it drops to 80000 or rises to 100000')).toBe('oco all tBTC sl 80000 tp 100000')
  })
  test('trailing stop and DCA', () => {
    expect(cmd('put a 5% trailing stop on all my btc')).toBe('trailing stop all tBTC 5%')
    expect(cmd('buy 5 dollars of bitcoin every day for a week')).toBe('dca 5 USDC into tBTC daily for 7 days')
    expect(cmd('dca 2 usdc into eth weekly for 4 weeks')).toBe('dca 2 USDC into tETH weekly for 28 days')
  })
  test('a token amount in a buy is converted using the oracle price and says so', () => {
    const r = interpretChat('buy 0.001 btc', base)
    expect(r.kind).toBe('command')
    if (r.kind === 'command') {
      expect(r.command).toBe('buy 90 USDC of tBTC')
      expect(r.note).toContain('about 90 USDC')
    }
  })
  test('every rewritten command is accepted by the strict parser', () => {
    for (const t of ['buy bitcoin for 10 dollars', 'sell half my btc if it falls to 80k', 'buy 5 dollars of eth every day for a week', 'put a 5% trailing stop on all my btc']) {
      expect(parseCommand(cmd(t)).ok).toBe(true)
    }
  })
})

describe('missing details are asked for, never guessed', () => {
  test('no amount, no token, no duration', () => {
    const a = interpretChat('buy bitcoin', base)
    expect(a.kind).toBe('reply')
    const b = interpretChat('buy 10 dollars', base)
    expect(b.kind === 'reply' && /which token/i.test(b.text)).toBe(true)
    const c = interpretChat('buy 5 dollars of bitcoin every day', base)
    expect(c.kind === 'reply' && /how long/i.test(c.text)).toBe(true)
    const d = interpretChat('trailing stop on my btc', base)
    expect(d.kind === 'reply' && /how far/i.test(d.text)).toBe(true)
  })
  test('a single-token network does not need the token named', () => {
    const one = { ...base, tokens: [tokens[0]] }
    expect(cmd('buy 10 dollars', one)).toBe('buy 10 USDC of tBTC')
  })
  test('gibberish is left for the caller', () => {
    expect(interpretChat('asdf qwer zxcv', base).kind).toBe('none')
    expect(interpretChat('', base).kind).toBe('none')
  })
})

describe('questions and chat', () => {
  test('explains order types without sending anything', () => {
    for (const q of ['what is a stop loss?', 'how does dca work', 'explain trailing stop', 'what is slippage', 'difference between oco and limit']) {
      const r = interpretChat(q, base)
      expect(r.kind).toBe('reply')
    }
    const r = interpretChat('what is a stop loss?', base)
    expect(r.kind === 'reply' && r.suggestions?.[0].mode).toBe('fill')
  })
  test('a polite order is an order, not a question', () => {
    expect(cmd('can you buy 10 usdc of btc')).toBe('buy 10 USDC of tBTC')
  })
  test('greetings, thanks and look-ups', () => {
    expect(interpretChat('hello', base).kind).toBe('reply')
    expect(interpretChat('thanks', base).kind).toBe('reply')
    expect(cmd('how much do i have')).toBe('balance')
    expect(cmd('show my open orders')).toBe('orders')
    expect(cmd('what is the price of bitcoin')).toBe('price tBTC')
  })
})

describe('suggestions', () => {
  test('from holdings and free USDC, with prices rounded and reasons given', () => {
    const r = interpretChat('what should I do?', base)
    expect(r.kind).toBe('reply')
    if (r.kind !== 'reply') return
    expect(r.text).toContain('not financial advice')
    const cmds = (r.suggestions ?? []).map((s) => s.command)
    expect(cmds).toContain('oco all tBTC sl 85500 tp 99000')
    expect(cmds).toContain('trailing stop all tBTC 5%')
    expect(cmds.some((c) => c.startsWith('dca '))).toBe(true)
    for (const s of r.suggestions ?? []) {
      expect(s.why.length).toBeGreaterThan(10)
      expect(parseCommand(s.command).ok).toBe(true)
    }
  })
  test('does not re-suggest protection for a token that already has a stop', () => {
    const s = buildSuggestions({ ...base, protectedSymbols: ['tBTC'] })
    expect(s.suggestions.some((x) => x.command.startsWith('oco'))).toBe(false)
  })
  test('without a wallet it offers samples to edit, and with nothing held it says so', () => {
    const a = buildSuggestions({ ...base, connected: false })
    expect(a.suggestions.every((s) => s.mode === 'fill')).toBe(true)
    const b = buildSuggestions({ ...base, holdings: [], freeQuote: 0 })
    expect(b.suggestions).toHaveLength(0)
    expect(b.text).toMatch(/no USDC/)
  })
  test('prices keep sensible digits', () => {
    expect(fmtPrice(85500.4)).toBe('85500')
    expect(fmtPrice(2.4567)).toBe('2.46')
    expect(fmtPrice(0.00123456)).toBe('0.001235')
  })
})

describe('strict commands with a common token name', () => {
  test('the typed name becomes the listed symbol; unknown names are left for the engine to refuse', () => {
    const p = parseCommand('buy 10 usdc of bitcoin')
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(canonicalizeIntent(p.intent, tokens)).toMatchObject({ kind: 'swap', token: 'tBTC' })
    const q = parseCommand('buy 10 usdc of banana')
    if (q.ok) expect(canonicalizeIntent(q.intent, tokens)).toMatchObject({ token: 'banana' })
    const r = parseCommand('buy 10 usdc of tETH')
    if (r.ok) expect(canonicalizeIntent(r.intent, tokens)).toMatchObject({ token: 'tETH' })
  })
})
