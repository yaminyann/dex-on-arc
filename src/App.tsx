import { useEffect } from 'react'
import { useAccount } from 'wagmi'
import { AnimatePresence } from 'framer-motion'
import { Toaster } from 'sonner'
import { NETWORKS } from '@/trading/networks'
import { SettingsProvider, useSettings } from '@/trading/settings'
import { Header } from '@/components/Header'
import { BottomNav } from '@/components/BottomNav'
import { Footer } from '@/components/Footer'
import { Terminal } from '@/components/Terminal'
import { Dashboard } from '@/components/Dashboard'
import { Admin } from '@/components/Admin'
import { AgentStation } from '@/components/AgentStation'
import { SettingsPage } from '@/components/SettingsPage'
import { Landing } from '@/components/Landing'
import { PageFade } from '@/components/motion'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Skeleton } from '@/components/ui'
import { useShortcuts } from '@/lib/shortcuts'

function Shell() {
  const { networkKey, page, setPage, toasts, toastPosition, theme } = useSettings()
  const { isConnected, status } = useAccount()
  const network = NETWORKS[networkKey]
  const reconnecting = status === 'connecting' || status === 'reconnecting'
  useShortcuts()

  // A connected wallet means the visitor is a user: skip the landing page and open the terminal.
  useEffect(() => {
    if (page === 'home' && isConnected) setPage('trade', { replace: true })
  }, [page, isConnected, setPage])

  const showLanding = page === 'home' && !isConnected

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:border focus:border-line focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">
        Skip to content
      </a>
      <Header network={network} />
      <main id="main" className="mx-auto max-w-[1600px] px-3 pb-6 pt-4 sm:px-5">
        <AnimatePresence mode="wait" initial={false}>
          <PageFade key={page} pageKey={page}>
            <ErrorBoundary resetKey={page}>
              {page === 'home' && (reconnecting ? <Skeleton className="h-[60vh]" /> : showLanding ? <Landing /> : null)}
              {page === 'trade' && <Terminal network={network} />}
              {page === 'dashboard' && <Dashboard network={network} />}
              {page === 'agent' && <AgentStation network={network} />}
              {page === 'settings' && <SettingsPage network={network} />}
              {page === 'admin' && <Admin network={network} />}
            </ErrorBoundary>
          </PageFade>
        </AnimatePresence>
      </main>
      <Footer />
      <BottomNav />
      {toasts !== 'off' && <Toaster position={toastPosition} offset={toastPosition === 'top-center' ? 64 : 76} duration={5000} theme={theme} />}
    </div>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <Shell />
    </SettingsProvider>
  )
}
