import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { NetworkKey } from './networks'

export type Theme = 'dark' | 'light'
export type Page = 'trade' | 'portfolio' | 'admin'

interface Settings {
  theme: Theme
  slippageBps: number
  expiryDays: number
  networkKey: NetworkKey
  page: Page
}

interface Ctx extends Settings {
  setTheme: (t: Theme) => void
  setSlippageBps: (bps: number) => void
  setExpiryDays: (d: number) => void
  setNetworkKey: (k: NetworkKey) => void
  setPage: (p: Page) => void
}

const KEY = 'arc-terminal-settings-v1'
const DEFAULTS: Settings = { theme: 'dark', slippageBps: 50, expiryDays: 7, networkKey: (import.meta.env.VITE_DEFAULT_NETWORK === 'arc' ? 'arc' : 'arc-testnet'), page: 'trade' }

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      slippageBps: clamp(Number(parsed.slippageBps ?? DEFAULTS.slippageBps), 1, 1000),
      expiryDays: clamp(Number(parsed.expiryDays ?? DEFAULTS.expiryDays), 1, 365),
      networkKey: parsed.networkKey === 'arc' ? 'arc' : 'arc-testnet',
      page: 'trade',
    }
  } catch {
    return DEFAULTS
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo
}

const SettingsContext = createContext<Ctx | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Settings>(load)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', state.theme === 'dark')
    const { page: _page, ...persisted } = state
    localStorage.setItem(KEY, JSON.stringify(persisted))
  }, [state])

  const patch = useCallback((p: Partial<Settings>) => setState((s) => ({ ...s, ...p })), [])

  const value = useMemo<Ctx>(
    () => ({
      ...state,
      setTheme: (theme) => patch({ theme }),
      setSlippageBps: (bps) => patch({ slippageBps: clamp(bps, 1, 1000) }),
      setExpiryDays: (d) => patch({ expiryDays: clamp(d, 1, 365) }),
      setNetworkKey: (networkKey) => patch({ networkKey }),
      setPage: (page) => patch({ page }),
    }),
    [state, patch],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider')
  return ctx
}
