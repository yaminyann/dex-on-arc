import { NETWORKS } from '@/trading/networks'
import { SettingsProvider, useSettings } from '@/trading/settings'
import { Header } from '@/components/Header'
import { Terminal } from '@/components/Terminal'
import { AnimatePresence } from 'framer-motion'
import { Toaster } from 'sonner'
import { Dashboard } from '@/components/Dashboard'
import { Admin } from '@/components/Admin'
import { AgentStation } from '@/components/AgentStation'
import { Footer } from '@/components/Footer'
import { Landing } from '@/components/Landing'
import { PageFade } from '@/components/motion'

function Shell() {
  const { networkKey, page, toasts, toastPosition, theme } = useSettings()
  const network = NETWORKS[networkKey]
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <Header network={network} />
      <main className="mx-auto max-w-[1600px] px-3 py-4 sm:px-5">
        <AnimatePresence mode="wait" initial={false}>
          <PageFade key={page} pageKey={page}>
            {page === 'home' && <Landing />}
            {page === 'trade' && <Terminal network={network} />}
            {page === 'dashboard' && <Dashboard network={network} />}
            {page === 'agent' && <AgentStation network={network} />}
            {page === 'admin' && <Admin network={network} />}
          </PageFade>
        </AnimatePresence>
      </main>
      <Footer />
      {toasts !== 'off' && <Toaster position={toastPosition} offset={toastPosition === 'top-center' ? 64 : 24} duration={5000} theme={theme} />}
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
