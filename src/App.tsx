import { NETWORKS } from '@/trading/networks'
import { SettingsProvider, useSettings } from '@/trading/settings'
import { Header } from '@/components/Header'
import { Terminal } from '@/components/Terminal'
import { Portfolio } from '@/components/Portfolio'
import { PromptStation } from '@/components/PromptStation'
import { NetworkBanner } from '@/components/SidePanels'

function Shell() {
  const { networkKey, page } = useSettings()
  const network = NETWORKS[networkKey]
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <Header network={network} />
      <main className="mx-auto max-w-[1500px] px-3 py-4 pb-24 sm:px-5">
        {page === 'trade' && <Terminal network={network} />}
        {page === 'portfolio' && (
          <div className="space-y-4">
            <NetworkBanner network={network} />
            <Portfolio network={network} />
          </div>
        )}
        {page === 'prompt' && <PromptStation />}
      </main>
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
