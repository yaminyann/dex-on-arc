import { ConnectKitButton } from 'connectkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { Moon, Settings as SettingsIcon, Sun } from 'lucide-react'
import { clsx } from 'clsx'
import { NETWORK_LIST, type NetworkConfig } from '@/trading/networks'
import { useSettings, type Page } from '@/trading/settings'
import { useBalances } from '@/trading/hooks'
import { useContractState } from '@/trading/admin'
import { formatToken } from '@/trading/math'
import { Logo } from './Logo'
import { Skeleton } from './ui'

/** The page links shared by the desktop header and the mobile tab bar, in one place. */
export function usePageLinks(): { id: Page; label: string }[] {
  const { isConnected } = useAccount()
  const links: { id: Page; label: string }[] = [
    { id: 'trade', label: 'Trade' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'agent', label: 'Agent' },
  ]
  // The landing page is for visitors. Once a wallet is connected the app opens on Trade.
  return isConnected ? links : [{ id: 'home', label: 'Home' }, ...links]
}

export function Header({ network }: { network: NetworkConfig }) {
  const s = useSettings()
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const balances = useBalances(network, address)
  const usdc = balances.data?.[network.quote.address.toLowerCase()]
  const wrongChain = isConnected && chainId !== network.chainId
  // Offered only to the contract owner (or the wallet it offered ownership to). The contract enforces access either way.
  const contract = useContractState(network).data
  const me = address?.toLowerCase()
  const isAdmin = Boolean(me && contract && (me === contract.owner.toLowerCase() || me === contract.pendingOwner?.toLowerCase()))
  const links = usePageLinks()
  const pages = isAdmin ? [...links, { id: 'admin' as Page, label: 'Admin' }] : links

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-3 md:h-16 md:gap-6 md:px-5">
        <button onClick={() => s.setPage(isConnected ? 'trade' : 'home')} aria-label={`${isConnected ? 'Open Trade' : 'Home'}`} className="flex min-h-[44px] shrink-0 items-center">
          <span className="hidden sm:block">
            <Logo />
          </span>
          <span className="sm:hidden">
            <Logo showName={false} size={32} />
          </span>
        </button>

        <nav className="hidden items-center gap-2 md:flex" aria-label="Pages">
          {pages.map((p) => (
            <button
              key={p.id}
              onClick={() => s.setPage(p.id)}
              aria-current={s.page === p.id ? 'page' : undefined}
              className={clsx(
                'min-h-[40px] border px-3.5 text-sm font-bold',
                s.page === p.id ? 'press border-line bg-accent text-accent-ink shadow-hard-sm' : 'border-transparent text-ink hover:border-line hover:bg-raised',
              )}
            >
              {p.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <label className="sr-only" htmlFor="network">
            Network
          </label>
          <select id="network" value={s.networkKey} onChange={(e) => s.setNetworkKey(e.target.value as typeof s.networkKey)} className="min-h-[44px] border border-line bg-panel px-2 text-xs font-bold text-ink md:min-h-[40px]">
            {NETWORK_LIST.map((n) => (
              <option key={n.key} value={n.key}>
                {n.isTestnet ? 'Testnet' : 'Mainnet'}
              </option>
            ))}
          </select>

          {isConnected && (
            <div className="num sensitive hidden min-h-[40px] items-center border border-line bg-panel px-2.5 text-xs font-semibold lg:flex" title="USDC balance (also your gas balance on Arc)">
              {balances.isLoading ? <Skeleton className="h-3 w-14" /> : `${formatToken(usdc ?? 0n, network.quote.decimals, 2)} USDC`}
            </div>
          )}

          {wrongChain && (
            <button onClick={() => switchChain({ chainId: network.chainId })} disabled={isPending} className="press min-h-[44px] whitespace-nowrap border border-line bg-down px-2.5 text-xs font-bold text-canvas shadow-hard-sm md:min-h-[40px]">
              Switch network
            </button>
          )}

          <ConnectKitButton.Custom>
            {({ isConnected: connected, show, truncatedAddress }) => (
              <button onClick={show} className="press min-h-[44px] whitespace-nowrap border border-line bg-accent px-3.5 text-xs font-bold text-accent-ink shadow-hard-sm md:min-h-[40px]">
                {connected ? truncatedAddress : 'Connect wallet'}
              </button>
            )}
          </ConnectKitButton.Custom>

          <button aria-label="Switch between light and dark" onClick={s.toggleTheme} className="press hidden h-10 w-10 place-items-center border border-line bg-panel shadow-hard-sm hover:bg-raised md:grid">
            {s.theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            aria-label="Open settings"
            aria-current={s.page === 'settings' ? 'page' : undefined}
            onClick={() => s.setPage('settings')}
            className={clsx('press hidden h-10 w-10 place-items-center border border-line shadow-hard-sm md:grid', s.page === 'settings' ? 'bg-accent text-accent-ink' : 'bg-panel hover:bg-raised')}
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  )
}
