import { useEffect } from 'react'
import { useSettings, type Page } from '@/trading/settings'

/** Press g, then a letter, to go to a page. Ignored while typing and when the setting is off. */
export const SHORTCUTS: { keys: string; page: Page; label: string }[] = [
  { keys: 'g h', page: 'home', label: 'Home' },
  { keys: 'g t', page: 'trade', label: 'Trade' },
  { keys: 'g d', page: 'dashboard', label: 'Dashboard' },
  { keys: 'g a', page: 'agent', label: 'Agent' },
  { keys: 'g s', page: 'settings', label: 'Settings' },
]

const TARGET: Record<string, Page> = { h: 'home', t: 'trade', d: 'dashboard', a: 'agent', s: 'settings' }

function typing(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

export function useShortcuts() {
  const { shortcuts, setPage } = useSettings()
  useEffect(() => {
    if (!shortcuts) return
    let armedAt = 0
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 'g') {
        armedAt = Date.now()
        return
      }
      if (armedAt && Date.now() - armedAt < 1200 && TARGET[k]) {
        armedAt = 0
        setPage(TARGET[k])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcuts, setPage])
}
