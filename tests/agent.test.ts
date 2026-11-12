import { describe, expect, test } from 'bun:test'
import { parseCommand, type Intent } from '../src/trading/agent/parser'
import { addSpent, DEFAULT_AGENT, gateCommand, loadSpentToday, sanitizePermission, type AgentPermission } from '../src/trading/agent-permission'
import { pageFromHash, sanitizeSettings } from '../src/trading/settings'

function ok(text: string): Intent {
  const r = parseCommand(text)
  if (!r.ok) throw new Error(`"${text}" -> ${r.error}`)
  return r.intent
}
function bad(text: string): string {
  const r = parseCommand(text)
  if (r.ok) throw new Error(`"${text}" should not parse`)
  return r.error
}

describe('agent parser: swaps', () => {
  test('buys with USDC in several phrasings', () => {
    for (const t of ['buy 10 USDC of tBTC', 'Buy tBTC with 10 usdc', 'buy $10 worth of tbtc', 'please buy 10 usdc tBTC now', 'kino 10 usdc tbtc']) {
      expect(ok(t)).toEqual({ kind: 'swap', side: 'buy', token: 'tbtc', amount: { kind: 'usdc', value: '10' } })
    }
  })

  test('a market buy must name the USDC to spend', () => {
    expect(bad('buy 0.001 tBTC')).toContain('USDC to spend')
    expect(bad('buy tBTC')).toContain('amount')
  })

  test('sells by amount, percentage, half or all', () => {
    expect(ok('sell 0.001 tBTC')).toEqual({ kind: 'swap', side: 'sell', token: 'tbtc', amount: { kind: 'token', value: '0.001' } })
    expect(ok('sell 50% of tBTC')).toEqual({ kind: 'swap', side: 'sell', token: 'tbtc', amount: { kind: 'percent', value: 50 } })
    expect(ok('sell half tbtc')).toEqual({ kind: 'swap', side: 'sell', token: 'tbtc', amount: { kind: 'percent', value: 50 } })
    expect(ok('sell all my tBTC')).toEqual({ kind: 'swap', side: 'sell', token: 'tbtc', amount: { kind: 'all' } })
  })

  test('refuses nonsense instead of guessing', () => {
    expect(bad('sell 10 usdc of tbtc')).toContain('amount of the token')
    expect(bad('sell 150% tbtc')).toContain('percentage')
    expect(bad('buy 0 usdc tbtc')).toContain('above zero')
    expect(bad('buy 10 usdc of tbtc and teth')).toContain('more than one token')
    expect(bad('')).toContain('Type a command')
    expect(bad('launch the rocket')).toContain('help')
  })

  test('accepts a token contract address', () => {
    const addr = '0x2c4047028a72803939b6fb674d01bc059b5c4961'
    expect(ok(`buy 5 usdc of ${addr}`)).toMatchObject({ kind: 'swap', token: addr })
  })
})

describe('agent parser: orders', () => {
  test('limit orders', () => {
    expect(ok('limit buy tBTC 5 USDC at 70000')).toEqual({ kind: 'limit', side: 'buy', token: 'tbtc', amount: { kind: 'usdc', value: '5' }, price: '70000' })
    expect(ok('limit sell 0.001 tBTC @ 95,000')).toEqual({ kind: 'limit', side: 'sell', token: 'tbtc', amount: { kind: 'token', value: '0.001' }, price: '95000' })
    expect(bad('limit buy tbtc 5 usdc')).toContain('price')
    expect(bad('limit tbtc 5 usdc at 70000')).toContain('limit buy or a limit sell')
  })

  test('stop-loss and take-profit, however they are spelled', () => {
    for (const t of ['stop loss 0.001 tBTC at 80000', 'Stop-Loss 0.001 tbtc @ 80000', 'sl 0.001 tbtc at 80000']) {
      expect(ok(t)).toEqual({ kind: 'stop_loss', token: 'tbtc', amount: { kind: 'token', value: '0.001' }, price: '80000' })
    }
    expect(ok('take profit all tbtc at 100000')).toEqual({ kind: 'take_profit', token: 'tbtc', amount: { kind: 'all' }, price: '100000' })
    expect(ok('tp 25% tbtc at 100000')).toEqual({ kind: 'take_profit', token: 'tbtc', amount: { kind: 'percent', value: 25 }, price: '100000' })
    expect(bad('stop loss 0.001 tbtc')).toContain('trigger price')
  })

  test('stop-limit needs both prices', () => {
    expect(ok('stop limit 0.001 tBTC stop 80000 limit 79000')).toEqual({ kind: 'stop_limit', token: 'tbtc', amount: { kind: 'token', value: '0.001' }, stop: '80000', limit: '79000' })
    expect(bad('stop limit 0.001 tbtc stop 80000')).toContain('both prices')
  })

  test('trailing stop reads the distance separately from the amount', () => {
    expect(ok('trailing stop 0.001 tBTC 5%')).toEqual({ kind: 'trailing', token: 'tbtc', amount: { kind: 'token', value: '0.001' }, trailPct: '5' })
    expect(ok('trailing 50% tbtc trail 3%')).toEqual({ kind: 'trailing', token: 'tbtc', amount: { kind: 'percent', value: 50 }, trailPct: '3' })
    expect(bad('trailing 0.001 tbtc')).toContain('distance')
    expect(bad('trailing 0.001 tbtc 80%')).toContain('between')
  })

  test('oco', () => {
    expect(ok('oco 0.001 tBTC sl 80000 tp 100000')).toEqual({ kind: 'oco', token: 'tbtc', amount: { kind: 'token', value: '0.001' }, stop: '80000', take: '100000' })
    expect(bad('oco 0.001 tbtc sl 80000')).toContain('both')
  })
})

describe('agent parser: dca and management', () => {
  test('dca plans', () => {
    expect(ok('dca 1 USDC into tBTC daily for 7 days')).toEqual({ kind: 'dca', token: 'tbtc', perBuy: '1', frequency: 'daily', days: 7, cap: undefined })
    expect(ok('dca 5 usdc tbtc weekly for 4 weeks cap 90000')).toEqual({ kind: 'dca', token: 'tbtc', perBuy: '5', frequency: 'weekly', days: 28, cap: '90000' })
    expect(ok('dca 2 usdc tbtc every hour for 2 days')).toMatchObject({ frequency: 'hourly', days: 2 })
    expect(bad('dca 1 usdc tbtc daily')).toContain('how long'.replace('how', 'For how'))
    expect(bad('dca 1 usdc tbtc for 7 days')).toContain('How often')
  })

  test('cancel, pause and resume', () => {
    expect(ok('cancel order 12')).toEqual({ kind: 'cancel_order', id: 12 })
    expect(ok('cancel 12')).toEqual({ kind: 'cancel_order', id: 12 })
    expect(ok('pause dca 3')).toEqual({ kind: 'manage_dca', action: 'pause', id: 3 })
    expect(ok('resume dca 3')).toEqual({ kind: 'manage_dca', action: 'resume', id: 3 })
    expect(ok('cancel dca 3')).toEqual({ kind: 'manage_dca', action: 'cancel', id: 3 })
    expect(bad('pause order 3')).toContain('dca')
    expect(bad('cancel order')).toContain('Which one')
  })

  test('read-only commands', () => {
    expect(ok('help')).toEqual({ kind: 'help' })
    expect(ok('balance')).toEqual({ kind: 'balance' })
    expect(ok('orders')).toEqual({ kind: 'orders' })
    expect(ok('price tBTC')).toEqual({ kind: 'price', token: 'tbtc' })
    expect(bad('price')).toContain('Which token')
  })
})

describe('agent permission', () => {
  const NOW = 1_800_000_000_000
  const granted = (over: Partial<AgentPermission> = {}): AgentPermission => ({ ...DEFAULT_AGENT, granted: true, grantedAt: NOW, ...over })

  test('no grant, no action', () => {
    expect(gateCommand(DEFAULT_AGENT, 'swap', 5, 0, NOW)).toMatchObject({ allowed: false })
  })

  test('an expired grant stops working', () => {
    expect(gateCommand(granted({ expiresAt: NOW - 1 }), 'swap', 5, 0, NOW)).toMatchObject({ allowed: false })
    expect(gateCommand(granted({ expiresAt: NOW + 1000 }), 'swap', 5, 0, NOW)).toMatchObject({ allowed: true })
    expect(gateCommand(granted({ expiresAt: null }), 'swap', 5, 0, NOW)).toMatchObject({ allowed: true })
  })

  test('scopes switch whole kinds of action off', () => {
    const p = granted({ scopes: { swap: true, orders: false, dca: true, manage: true } })
    expect(gateCommand(p, 'orders', 5, 0, NOW)).toMatchObject({ allowed: false })
    expect(gateCommand(p, 'swap', 5, 0, NOW)).toMatchObject({ allowed: true })
  })

  test('per-command and daily limits are enforced', () => {
    const p = granted({ maxPerCommand: 50, dailyLimit: 80 })
    expect(gateCommand(p, 'swap', 60, 0, NOW)).toMatchObject({ allowed: false })
    expect(gateCommand(p, 'swap', 40, 0, NOW)).toMatchObject({ allowed: true })
    expect(gateCommand(p, 'swap', 40, 50, NOW)).toMatchObject({ allowed: false })
  })

  test('auto-run needs auto mode and a known size; otherwise the agent always asks', () => {
    expect(gateCommand(granted({ mode: 'confirm' }), 'swap', 5, 0, NOW)).toEqual({ allowed: true, autoRun: false })
    expect(gateCommand(granted({ mode: 'auto' }), 'swap', 5, 0, NOW)).toEqual({ allowed: true, autoRun: true })
    expect(gateCommand(granted({ mode: 'auto' }), 'swap', null, 0, NOW)).toEqual({ allowed: true, autoRun: false })
  })

  test('hand-edited storage is clamped', () => {
    const p = sanitizePermission({ granted: true, mode: 'yolo', maxPerCommand: -5, dailyLimit: 'lots', scopes: { swap: false } })
    expect(p.mode).toBe('confirm')
    expect(p.maxPerCommand).toBe(0)
    expect(p.dailyLimit).toBe(DEFAULT_AGENT.dailyLimit)
    expect(p.scopes.swap).toBe(false)
    expect(p.scopes.orders).toBe(true)
    expect(sanitizePermission(undefined).granted).toBe(false)
  })

  test('daily usage resets on a new day', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const day1 = Date.UTC(2026, 10, 12, 10)
    const day2 = Date.UTC(2026, 10, 13, 1)
    expect(addSpent(10, day1, storage)).toBe(10)
    expect(addSpent(5, day1, storage)).toBe(15)
    expect(loadSpentToday(day1, storage)).toBe(15)
    expect(loadSpentToday(day2, storage)).toBe(0)
  })
})

describe('settings', () => {
  test('old and broken stored values are repaired, not trusted', () => {
    const s = sanitizeSettings({ theme: 'light', slippageBps: 99999, expiryDays: 'x', accent: 'aurora', scale: 'huge', motion: 'warp', density: 'tiny', startPage: 'admin', toasts: 'loud', defaultTimeframe: '3h', networkKey: 'mars', agent: { granted: 'yes' } })
    expect(s.themePref).toBe('light')
    expect(s.slippageBps).toBe(1000)
    expect(s.expiryDays).toBe(1)
    // Retired accents (iris, teal) and unknown ones fall back to the default.
    expect(s.accent).toBe('lavender')
    expect(sanitizeSettings({ accent: 'iris' }).accent).toBe('lavender')
    // Names from the yellow build map to the nearest soft colour.
    expect(sanitizeSettings({ accent: 'signal' }).accent).toBe('butter')
    expect(sanitizeSettings({ accent: 'pink' }).accent).toBe('rose')
    expect(s.scale).toBe('md')
    expect(s.motion).toBe('full')
    expect(s.density).toBe('comfortable')
    expect(s.startPage).toBe('home')
    expect(s.toasts).toBe('all')
    expect(s.defaultTimeframe).toBe('1h')
    expect(s.networkKey).toBe('arc-testnet')
    expect(s.agent.granted).toBe(false)
  })

  test('valid values survive', () => {
    const s = sanitizeSettings({ themePref: 'system', accent: 'peach', scale: 'lg', motion: 'reduced', density: 'compact', startPage: 'trade', toasts: 'errors', toastPosition: 'bottom-right', chartType: 'line', defaultOrderType: 'limit', defaultTimeframe: '4h', chartVolume: false, networkKey: 'arc', timeFormat: '12h', timeZone: 'utc', privacy: true, shortcuts: false })
    expect(s).toMatchObject({ themePref: 'system', accent: 'peach', scale: 'lg', motion: 'reduced', density: 'compact', startPage: 'trade', toasts: 'errors', toastPosition: 'bottom-right', chartType: 'line', defaultOrderType: 'limit', defaultTimeframe: '4h', chartVolume: false, networkKey: 'arc', timeFormat: '12h', timeZone: 'utc', privacy: true, shortcuts: false })
    expect(s.page).toBe('trade')
  })

  test('hostile or empty input never throws and never escapes the allowed values', () => {
    for (const raw of [null, undefined, 5, 'x', [], [1, 2], { timeZone: 'Mars/Base', timeFormat: 7, privacy: 'true', shortcuts: 0, slippageBps: -5, expiryDays: 1e99 }, JSON.parse('{"__proto__":{"accent":"x"},"accent":{"a":1}}')]) {
      const s = sanitizeSettings(raw)
      expect(s.accent).toBe('lavender')
      expect(['local', 'utc']).toContain(s.timeZone)
      expect(['24h', '12h']).toContain(s.timeFormat)
      expect(s.privacy).toBe(false)
      expect(s.slippageBps).toBeGreaterThanOrEqual(1)
      expect(s.slippageBps).toBeLessThanOrEqual(1000)
      expect(s.expiryDays).toBeGreaterThanOrEqual(1)
      expect(s.expiryDays).toBeLessThanOrEqual(365)
    }
  })
})

describe('page links', () => {
  test('the hash names a page, and anything else is ignored', () => {
    expect(pageFromHash('#/agent')).toBe('agent')
    expect(pageFromHash('#agent')).toBe('agent')
    expect(pageFromHash('#/trade?x=1')).toBe('trade')
    expect(pageFromHash('#/home')).toBe('home')
    expect(pageFromHash('#/settings')).toBe('settings')
    expect(pageFromHash('#/lending')).toBeNull()
    expect(pageFromHash('')).toBeNull()
    expect(pageFromHash('#/../../etc')).toBeNull()
  })
})
