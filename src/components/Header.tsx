import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { CandlestickChart, Moon, Settings as SettingsIcon, Sparkles, Sun } from 'lucide-react'
import { clsx } from 'clsx'
import { NETWORK_LIST, type NetworkConfig } from '@/trading/networks'
import { useSettings, type Page } from '@/trading/settings'
import { useBalances } from '@/trading/hooks'
import { formatToken } from '@/trading/math'
import { Badge, Skeleton } from './ui'
import { SettingsDialog } from './SettingsDialog'

const PAGES: { id: Page; label: string; soon?: boolean }[] = [
  { id: 'trade', label: 'Trade' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'prompt', label: 'Prompt Station', soon: true },
]

export function Header({ network }: { network: NetworkConfig }) {
  const s = useSettings()
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const balances = useBalances(network, address)
  const usdc = balances.data?.[network.quote.address.toLowerCase()]
  const wrongChain = isConnected && chainId !== network.chainId

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-ink">
            <CandlestickChart className="h-4 w-4" />
          </span>
          <span className="font-display text-[15px] font-semibold tracking-tight">Arc Terminal</span>
        </div>

        <nav className="order-last flex w-full gap-1 overflow-x-auto thin-scroll sm:order-none sm:w-auto" aria-label="Pages">
          {PAGES.map((p) => (
            <button
              key={p.id}
              onClick={() => s.setPage(p.id)}
              className={clsx(
                'flex min-h-[36px] items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm transition',
                s.page === p.id ? 'bg-raised text-ink' : 'text-mute hover:text-ink',
              )}
            >
              {p.id === 'prompt' && <Sparkles className="h-3.5 w-3.5" />}
              {p.label}
              {p.soon && <Badge tone="accent">Soon</Badge>}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor="network">
            Network
          </label>
          <select
            id="network"
            value={s.networkKey}
            onChange={(e) => s.setNetworkKey(e.target.value as typeof s.networkKey)}
            className="min-h-[36px] rounded-lg border border-line bg-raised px-2.5 text-xs text-ink outline-none focus:border-accent"
          >
            {NETWORK_LIST.map((n) => (
              <option key={n.key} value={n.key}>
                {n.label}
                {n.isTestnet ? ' (testnet)' : ''}
              </option>
            ))}
          </select>

          {isConnected && (
            <div className="num hidden min-h-[36px] items-center rounded-lg border border-line px-2.5 text-xs sm:flex" title="USDC balance (ERC-20 view)">
              {balances.isLoading ? <Skeleton className="h-3 w-14" /> : `${formatToken(usdc ?? 0n, network.quote.decimals, 2)} USDC`}
            </div>
          )}

          {wrongChain && (
            <button
              onClick={() => switchChain({ chainId: network.chainId })}
              disabled={isPending}
              className="min-h-[36px] rounded-lg border border-warn/50 px-2.5 text-xs text-warn hover:bg-warn/10"
            >
              Switch to {network.label}
            </button>
          )}

          <ConnectKitButton.Custom>
            {({ isConnected: connected, show, truncatedAddress }) => (
              <button
                onClick={show}
                className="min-h-[36px] rounded-lg bg-accent px-3 text-xs font-medium text-accent-ink hover:opacity-90"
              >
                {connected ? truncatedAddress : 'Connect wallet'}
              </button>
            )}
          </ConnectKitButton.Custom>

          <button
            aria-label="Toggle theme"
            onClick={() => s.setTheme(s.theme === 'dark' ? 'light' : 'dark')}
            className="grid h-9 w-9 place-items-center rounded-lg border border-line text-mute hover:text-ink"
          >
            {s.theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-line text-mute hover:text-ink"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}
