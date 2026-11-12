import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { NetworkKey } from './networks'
import type { Timeframe } from './market'
import { DEFAULT_AGENT, sanitizePermission, type AgentPermission } from './agent-permission'
import { timePrefs } from './format'

export type ThemePref = 'dark' | 'light' | 'system'
export type Theme = 'dark' | 'light'
export type Accent = 'lavender' | 'peach' | 'rose' | 'sky' | 'butter'
export type Scale = 'sm' | 'md' | 'lg'
export type DefaultOrderType = 'market' | 'limit'
export type Page = 'home' | 'trade' | 'dashboard' | 'agent' | 'settings' | 'admin'
export type TimeFormat = '24h' | '12h'
export type TimeZoneMode = 'local' | 'utc'
export type StartPage = 'home' | 'trade' | 'dashboard'
export type Motion = 'full' | 'reduced' | 'off'
export type Density = 'comfortable' | 'compact'
export type ChartType = 'candles' | 'line'
export type ToastPosition = 'top-center' | 'bottom-center' | 'bottom-right'
export type ToastMode = 'all' | 'errors' | 'off'

export const PAGES: Page[] = ['home', 'trade', 'dashboard', 'agent', 'settings', 'admin']

/**
 * Accent colours as a flat fill (RGB). Text on an accent is always ink, which keeps at least 8:1
 * contrast on every one of them in both themes. The accent is never used as text colour.
 */
export const ACCENTS: Record<Accent, { label: string; rgb: string }> = {
  lavender: { label: 'Soft lavender', rgb: '201 184 255' },
  peach: { label: 'Soft peach', rgb: '255 192 154' },
  rose: { label: 'Soft rose', rgb: '255 179 207' },
  sky: { label: 'Soft sky', rgb: '168 216 255' },
  butter: { label: 'Soft butter', rgb: '255 229 138' },
}

/** Names used by earlier builds, mapped to the nearest soft colour so a saved choice survives. */
const LEGACY_ACCENTS: Record<string, Accent> = { signal: 'butter', orange: 'peach', pink: 'rose', violet: 'lavender' }

export const SCALES: Record<Scale, { label: string; px: number }> = {
  sm: { label: 'Compact', px: 14 },
  md: { label: 'Default', px: 16 },
  lg: { label: 'Large', px: 18 },
}

export const TIMEFRAME_CHOICES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W']

export interface Settings {
  themePref: ThemePref
  accent: Accent
  timeFormat: TimeFormat
  timeZone: TimeZoneMode
  privacy: boolean
  shortcuts: boolean
  scale: Scale
  motion: Motion
  density: Density
  startPage: StartPage
  slippageBps: number
  expiryDays: number
  defaultOrderType: DefaultOrderType
  defaultTimeframe: Timeframe
  chartType: ChartType
  chartVolume: boolean
  chartMa: boolean
  showNetworkBanner: boolean
  toasts: ToastMode
  toastPosition: ToastPosition
  networkKey: NetworkKey
  page: Page
  agent: AgentPermission
}

interface Ctx extends Settings {
  /** The theme in effect: `themePref` with "system" resolved. */
  theme: Theme
  /** True when animation is allowed: the setting is not "off" and the system does not ask for less motion. */
  animate: boolean
  setThemePref: (t: ThemePref) => void
  /** Flips between dark and light (the header button). */
  toggleTheme: () => void
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  setSlippageBps: (bps: number) => void
  setExpiryDays: (d: number) => void
  setNetworkKey: (k: NetworkKey) => void
  /** `replace` swaps the current history entry, so a redirect does not trap the back button. */
  setPage: (p: Page, opts?: { replace?: boolean }) => void
  setAgent: (p: AgentPermission) => void
  /** Replaces every stored setting from an exported file. Values are sanitised first. */
  importSettings: (raw: unknown) => void
  resetAll: () => void
}

const KEY = 'lumarc-settings-v2'
/** Earlier builds stored settings under these keys; they are read once, never written. */
const OLD_KEYS = ['lumarc-settings-v1', 'arc-terminal-settings-v1']
const DEFAULT_NETWORK: NetworkKey = import.meta.env.VITE_DEFAULT_NETWORK === 'arc' ? 'arc' : 'arc-testnet'

export const DEFAULTS: Settings = {
  themePref: 'light',
  accent: 'lavender',
  timeFormat: '24h',
  timeZone: 'local',
  privacy: false,
  shortcuts: true,
  scale: 'md',
  motion: 'full',
  density: 'comfortable',
  startPage: 'home',
  slippageBps: 50,
  expiryDays: 7,
  defaultOrderType: 'market',
  defaultTimeframe: '1h',
  chartType: 'candles',
  chartVolume: true,
  chartMa: true,
  showNetworkBanner: true,
  toasts: 'all',
  toastPosition: 'top-center',
  networkKey: DEFAULT_NETWORK,
  page: 'home',
  agent: DEFAULT_AGENT,
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo
}

const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)

/** Reads stored settings, tolerating missing, old or hand-edited values. Exported for tests. */
export function sanitizeSettings(raw: unknown): Settings {
  const p = (raw ?? {}) as Record<string, unknown>
  // The first build stored a plain "theme" of dark or light.
  const legacyTheme = p.theme === 'light' ? 'light' : p.theme === 'dark' ? 'dark' : undefined
  const startPage = oneOf(p.startPage, ['home', 'trade', 'dashboard'], DEFAULTS.startPage)
  return {
    themePref: oneOf(p.themePref ?? legacyTheme, ['dark', 'light', 'system'], DEFAULTS.themePref),
    accent: oneOf(typeof p.accent === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_ACCENTS, p.accent) ? LEGACY_ACCENTS[p.accent] : p.accent, Object.keys(ACCENTS) as Accent[], DEFAULTS.accent),
    timeFormat: oneOf(p.timeFormat, ['24h', '12h'], DEFAULTS.timeFormat),
    timeZone: oneOf(p.timeZone, ['local', 'utc'], DEFAULTS.timeZone),
    privacy: p.privacy === true,
    shortcuts: p.shortcuts !== false,
    scale: oneOf(p.scale, ['sm', 'md', 'lg'], DEFAULTS.scale),
    motion: oneOf(p.motion, ['full', 'reduced', 'off'], DEFAULTS.motion),
    density: oneOf(p.density, ['comfortable', 'compact'], DEFAULTS.density),
    startPage,
    slippageBps: clamp(Number(p.slippageBps ?? DEFAULTS.slippageBps), 1, 1000),
    expiryDays: clamp(Number(p.expiryDays ?? DEFAULTS.expiryDays), 1, 365),
    defaultOrderType: oneOf(p.defaultOrderType, ['market', 'limit'], DEFAULTS.defaultOrderType),
    defaultTimeframe: oneOf(p.defaultTimeframe, TIMEFRAME_CHOICES, DEFAULTS.defaultTimeframe),
    chartType: oneOf(p.chartType, ['candles', 'line'], DEFAULTS.chartType),
    chartVolume: p.chartVolume !== false,
    chartMa: p.chartMa !== false,
    showNetworkBanner: p.showNetworkBanner !== false,
    toasts: oneOf(p.toasts, ['all', 'errors', 'off'], DEFAULTS.toasts),
    toastPosition: oneOf(p.toastPosition, ['top-center', 'bottom-center', 'bottom-right'], DEFAULTS.toastPosition),
    networkKey: oneOf(p.networkKey, ['arc', 'arc-testnet'], DEFAULTS.networkKey),
    page: startPage,
    agent: sanitizePermission(p.agent),
  }
}

/** The page named by the URL hash (`#/trade`), if it is one we have. */
export function pageFromHash(hash: string): Page | null {
  const name = hash.replace(/^#\/?/, '').split(/[/?]/)[0]
  return PAGES.includes(name as Page) ? (name as Page) : null
}

function load(): Settings {
  try {
    const raw = [KEY, ...OLD_KEYS].map((k) => localStorage.getItem(k)).find((v) => v !== null)
    const s = raw ? sanitizeSettings(JSON.parse(raw)) : DEFAULTS
    // A link such as /#/agent wins over the start page.
    return { ...s, page: pageFromHash(location.hash) ?? s.startPage }
  } catch {
    return DEFAULTS
  }
}

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function systemReducesMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

const SettingsContext = createContext<Ctx | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Settings>(load)
  const [system, setSystem] = useState<Theme>(systemTheme)
  const [reduceMotion, setReduceMotion] = useState(systemReducesMotion)

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const light = matchMedia('(prefers-color-scheme: light)')
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const onTheme = () => setSystem(light.matches ? 'light' : 'dark')
    const onMotion = () => setReduceMotion(motion.matches)
    light.addEventListener('change', onTheme)
    motion.addEventListener('change', onMotion)
    return () => {
      light.removeEventListener('change', onTheme)
      motion.removeEventListener('change', onMotion)
    }
  }, [])

  // Back and forward buttons, and links, move between pages.
  useEffect(() => {
    const onHash = () => {
      const next = pageFromHash(location.hash)
      if (next) setState((s) => (s.page === next ? s : { ...s, page: next }))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const theme: Theme = state.themePref === 'system' ? system : state.themePref
  const animate = state.motion !== 'off' && !reduceMotion

  // Apply every visual setting live: theme class, accent colours, interface size, density and motion.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.style.setProperty('--accent', ACCENTS[state.accent].rgb)
    root.style.setProperty('--accent-fg', '17 17 17')
    root.style.fontSize = `${SCALES[state.scale].px}px`
    root.dataset.density = state.density
    root.dataset.motion = animate ? state.motion : 'off'
    root.dataset.toasts = state.toasts
    root.dataset.privacy = state.privacy ? 'on' : 'off'
    timePrefs.hour12 = state.timeFormat === '12h'
    timePrefs.utc = state.timeZone === 'utc'
  }, [theme, state.accent, state.scale, state.density, state.motion, state.toasts, state.privacy, state.timeFormat, state.timeZone, animate])

  useEffect(() => {
    const { page: _page, ...persisted } = state
    localStorage.setItem(KEY, JSON.stringify(persisted))
  }, [state])

  const patch = useCallback((p: Partial<Settings>) => setState((s) => ({ ...s, ...p })), [])

  const value = useMemo<Ctx>(
    () => ({
      ...state,
      theme,
      animate,
      setThemePref: (themePref) => patch({ themePref }),
      toggleTheme: () => patch({ themePref: theme === 'dark' ? 'light' : 'dark' }),
      set: (key, v) => patch({ [key]: v }),
      setSlippageBps: (bps) => patch({ slippageBps: clamp(bps, 1, 1000) }),
      setExpiryDays: (d) => patch({ expiryDays: clamp(d, 1, 365) }),
      setNetworkKey: (networkKey) => patch({ networkKey }),
      setPage: (page, opts) => {
        patch({ page })
        // Keeps the address bar in step so a page can be linked and the back button works.
        if (pageFromHash(location.hash) === page) return
        if (opts?.replace) history.replaceState(null, '', `#/${page}`)
        else location.hash = `/${page}`
      },
      setAgent: (agent) => patch({ agent }),
      importSettings: (raw) => {
        const wanted = sanitizeSettings(raw)
        setState((s) => ({ ...wanted, page: s.page }))
      },
      resetAll: () => setState({ ...DEFAULTS, networkKey: state.networkKey, page: state.page }),
    }),
    [state, theme, animate, patch],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider')
  return ctx
}
