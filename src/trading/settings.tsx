import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { NetworkKey } from './networks'
import type { Timeframe } from './market'
import { DEFAULT_AGENT, sanitizePermission, type AgentPermission } from './agent-permission'

export type ThemePref = 'dark' | 'light' | 'system'
export type Theme = 'dark' | 'light'
export type Accent = 'aurora' | 'azure' | 'violet' | 'amber' | 'rose'
export type Scale = 'sm' | 'md' | 'lg'
export type DefaultOrderType = 'market' | 'limit'
export type Page = 'trade' | 'dashboard' | 'lending' | 'agent' | 'admin'

/** Accent colours as space-separated RGB for each theme, with the text colour that reads on top of them. */
export const ACCENTS: Record<Accent, { label: string; dark: [string, string]; light: [string, string] }> = {
  aurora: { label: 'Aurora', dark: ['45 212 191', '4 20 22'], light: ['13 148 136', '255 255 255'] },
  azure: { label: 'Azure', dark: ['96 165 250', '6 18 36'], light: ['37 99 235', '255 255 255'] },
  violet: { label: 'Violet', dark: ['167 139 250', '20 10 44'], light: ['124 58 237', '255 255 255'] },
  amber: { label: 'Amber', dark: ['251 191 36', '32 20 2'], light: ['180 110 10', '255 255 255'] },
  rose: { label: 'Rose', dark: ['251 113 133', '40 6 16'], light: ['225 29 72', '255 255 255'] },
}

export const SCALES: Record<Scale, { label: string; px: number }> = {
  sm: { label: 'Compact', px: 14 },
  md: { label: 'Default', px: 16 },
  lg: { label: 'Large', px: 18 },
}

export const TIMEFRAME_CHOICES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W']

export interface Settings {
  themePref: ThemePref
  accent: Accent
  scale: Scale
  slippageBps: number
  expiryDays: number
  defaultOrderType: DefaultOrderType
  defaultTimeframe: Timeframe
  chartVolume: boolean
  chartMa: boolean
  showNetworkBanner: boolean
  networkKey: NetworkKey
  page: Page
  agent: AgentPermission
}

interface Ctx extends Settings {
  /** The theme in effect: `themePref` with "system" resolved. */
  theme: Theme
  setThemePref: (t: ThemePref) => void
  /** Flips between dark and light (the header button). */
  toggleTheme: () => void
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  setSlippageBps: (bps: number) => void
  setExpiryDays: (d: number) => void
  setNetworkKey: (k: NetworkKey) => void
  setPage: (p: Page) => void
  setAgent: (p: AgentPermission) => void
  resetAll: () => void
}

const KEY = 'arcora-settings-v2'
const OLD_KEY = 'arc-terminal-settings-v1'
const DEFAULT_NETWORK: NetworkKey = import.meta.env.VITE_DEFAULT_NETWORK === 'arc' ? 'arc' : 'arc-testnet'

export const DEFAULTS: Settings = {
  themePref: 'dark',
  accent: 'aurora',
  scale: 'md',
  slippageBps: 50,
  expiryDays: 7,
  defaultOrderType: 'market',
  defaultTimeframe: '1h',
  chartVolume: true,
  chartMa: true,
  showNetworkBanner: true,
  networkKey: DEFAULT_NETWORK,
  page: 'trade',
  agent: DEFAULT_AGENT,
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo
}

const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)

/** Reads stored settings, tolerating missing, old or hand-edited values. Exported for tests. */
export function sanitizeSettings(raw: unknown): Settings {
  const p = (raw ?? {}) as Record<string, unknown>
  // v1 stored a plain "theme" of dark or light.
  const legacyTheme = p.theme === 'light' ? 'light' : p.theme === 'dark' ? 'dark' : undefined
  return {
    themePref: oneOf(p.themePref ?? legacyTheme, ['dark', 'light', 'system'], DEFAULTS.themePref),
    accent: oneOf(p.accent, Object.keys(ACCENTS) as Accent[], DEFAULTS.accent),
    scale: oneOf(p.scale, ['sm', 'md', 'lg'], DEFAULTS.scale),
    slippageBps: clamp(Number(p.slippageBps ?? DEFAULTS.slippageBps), 1, 1000),
    expiryDays: clamp(Number(p.expiryDays ?? DEFAULTS.expiryDays), 1, 365),
    defaultOrderType: oneOf(p.defaultOrderType, ['market', 'limit'], DEFAULTS.defaultOrderType),
    defaultTimeframe: oneOf(p.defaultTimeframe, TIMEFRAME_CHOICES, DEFAULTS.defaultTimeframe),
    chartVolume: p.chartVolume !== false,
    chartMa: p.chartMa !== false,
    showNetworkBanner: p.showNetworkBanner !== false,
    networkKey: oneOf(p.networkKey, ['arc', 'arc-testnet'], DEFAULTS.networkKey),
    page: 'trade',
    agent: sanitizePermission(p.agent),
  }
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY)
    return raw ? sanitizeSettings(JSON.parse(raw)) : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

const SettingsContext = createContext<Ctx | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Settings>(load)
  const [system, setSystem] = useState<Theme>(systemTheme)

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-color-scheme: light)')
    const on = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const theme: Theme = state.themePref === 'system' ? system : state.themePref

  // Apply every visual setting live: theme class, accent colours and interface size.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    const [rgb, fg] = ACCENTS[state.accent][theme]
    root.style.setProperty('--accent', rgb)
    root.style.setProperty('--accent-fg', fg)
    root.style.fontSize = `${SCALES[state.scale].px}px`
  }, [theme, state.accent, state.scale])

  useEffect(() => {
    const { page: _page, ...persisted } = state
    localStorage.setItem(KEY, JSON.stringify(persisted))
  }, [state])

  const patch = useCallback((p: Partial<Settings>) => setState((s) => ({ ...s, ...p })), [])

  const value = useMemo<Ctx>(
    () => ({
      ...state,
      theme,
      setThemePref: (themePref) => patch({ themePref }),
      toggleTheme: () => patch({ themePref: theme === 'dark' ? 'light' : 'dark' }),
      set: (key, v) => patch({ [key]: v }),
      setSlippageBps: (bps) => patch({ slippageBps: clamp(bps, 1, 1000) }),
      setExpiryDays: (d) => patch({ expiryDays: clamp(d, 1, 365) }),
      setNetworkKey: (networkKey) => patch({ networkKey }),
      setPage: (page) => patch({ page }),
      setAgent: (agent) => patch({ agent }),
      resetAll: () => setState({ ...DEFAULTS, networkKey: state.networkKey, page: state.page }),
    }),
    [state, theme, patch],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider')
  return ctx
}
