import { NETWORKS } from '@/trading/networks'
import { SettingsProvider, useSettings } from '@/trading/settings'
import { Header } from '@/components/Header'
import { Terminal } from '@/components/Terminal'
import { Dashboard } from '@/components/Dashboard'
import { Admin } from '@/components/Admin'
import { Lending } from '@/components/Lending'
import { AgentStation } from '@/components/AgentStation'
import { Footer } from '@/components/Footer'

function Shell() {
  const { networkKey, page } = useSettings()
  const network = NETWORKS[networkKey]
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <Header network={network} />
      <main className="mx-auto max-w-[1600px] px-3 py-4 sm:px-5">
        {page === 'trade' && <Terminal network={network} />}
        {page === 'dashboard' && <Dashboard network={network} />}
        {page === 'lending' && <Lending network={network} />}
        {page === 'agent' && <AgentStation network={network} />}
        {page === 'admin' && <Admin network={network} />}
      </main>
      <Footer />
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
