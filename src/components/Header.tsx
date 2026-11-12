import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { Moon, Settings as SettingsIcon, Sparkles, Sun } from 'lucide-react'
import { clsx } from 'clsx'
import { NETWORK_LIST, type NetworkConfig } from '@/trading/networks'
import { useSettings, type Page } from '@/trading/settings'
import { useBalances } from '@/trading/hooks'
import { useContractState } from '@/trading/admin'
import { formatToken } from '@/trading/math'
import { Logo } from './Logo'
import { Skeleton } from './ui'
import { SettingsDialog } from './SettingsDialog'

const PAGES: { id: Page; label: string }[] = [
  { id: 'trade', label: 'Trade' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'agent', label: 'Agent' },
]

export function Header({ network }: { network: NetworkConfig }) {
  const s = useSettings()
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const balances = useBalances(network, address)
  const usdc = balances.data?.[network.quote.address.toLowerCase()]
  const wrongChain = isConnected && chainId !== network.chainId
  // Offered only to the contract owner (or the wallet it offered ownership to). The contract enforces access either way.
  const contract = useContractState(network).data
  const me = address?.toLowerCase()
  const isAdmin = Boolean(me && contract && (me === contract.owner.toLowerCase() || me === contract.pendingOwner?.toLowerCase()))
  const pages = isAdmin ? [...PAGES, { id: 'admin' as Page, label: 'Admin' }] : PAGES

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:gap-x-5 sm:px-5">
        <button onClick={() => s.setPage('home')} aria-label="Home" className="shrink-0">
          <span className="hidden sm:block">
            <Logo />
          </span>
          <span className="sm:hidden">
            <Logo showName={false} />
          </span>
        </button>

        <nav className="order-last flex w-full gap-0.5 overflow-x-auto thin-scroll sm:order-none sm:w-auto" aria-label="Pages">
          {pages.map((p) => (
            <button
              key={p.id}
              onClick={() => s.setPage(p.id)}
              aria-current={s.page === p.id ? 'page' : undefined}
              className={clsx(
                'flex min-h-[36px] items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition',
                s.page === p.id ? 'text-accent' : 'text-mute hover:text-ink',
              )}
            >
              {p.id === 'agent' && <Sparkles className="h-3.5 w-3.5" />}
              {p.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <label className="sr-only" htmlFor="network">
            Network
          </label>
          <select
            id="network"
            value={s.networkKey}
            onChange={(e) => s.setNetworkKey(e.target.value as typeof s.networkKey)}
            className="min-h-[36px] rounded-lg border border-line bg-raised px-2 text-xs text-ink outline-none focus:border-accent"
          >
            {NETWORK_LIST.map((n) => (
              <option key={n.key} value={n.key}>
                {n.isTestnet ? 'Testnet' : 'Mainnet'}
              </option>
            ))}
          </select>

          {isConnected && (
            <div className="num hidden min-h-[36px] items-center rounded-lg border border-line px-2.5 text-xs sm:flex" title="USDC balance (also your gas balance on Arc)">
              {balances.isLoading ? <Skeleton className="h-3 w-14" /> : `${formatToken(usdc ?? 0n, network.quote.decimals, 2)} USDC`}
            </div>
          )}

          {wrongChain && (
            <button
              onClick={() => switchChain({ chainId: network.chainId })}
              disabled={isPending}
              className="min-h-[36px] whitespace-nowrap rounded-lg border border-warn/50 px-2.5 text-xs text-warn hover:bg-warn/10"
            >
              Switch network
            </button>
          )}

          <ConnectKitButton.Custom>
            {({ isConnected: connected, show, truncatedAddress }) => (
              <button onClick={show} className="min-h-[36px] whitespace-nowrap rounded-lg bg-accent px-3.5 text-xs font-semibold text-accent-ink hover:opacity-90">
                {connected ? truncatedAddress : 'Connect'}
              </button>
            )}
          </ConnectKitButton.Custom>

          <button
            aria-label="Toggle theme"
            onClick={s.toggleTheme}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-mute hover:text-ink"
          >
            {s.theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-mute hover:text-ink"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}
