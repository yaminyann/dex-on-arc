import { useState } from 'react'
import { X } from 'lucide-react'
import type { NetworkConfig } from '@/trading/networks'
import { useSettings } from '@/trading/settings'
import { Notice } from './ui'

const key = (network: NetworkConfig) => `arc-terminal-banner-${network.key}`

/** Testnet explanation (dismissible, remembered) or the permanent mainnet real-funds warning. */
export function NetworkBanner({ network }: { network: NetworkConfig }) {
  const { showNetworkBanner } = useSettings()
  const [hidden, setHidden] = useState(() => network.isTestnet && localStorage.getItem(key(network)) === '1')
  if (!network.isTestnet) {
    return (
      <Notice tone="warn" title="Arc mainnet: real funds">
        Transactions are irreversible. {network.ordersAddress ? '' : 'The order contract is not set up for mainnet yet.'}
      </Notice>
    )
  }
  if (hidden || !showNetworkBanner) return null
  return (
    <div className="relative">
      <Notice tone="info" title="Arc Testnet">
        <span className="pr-8">
          The test tokens (tBTC, tETH, tSOL) follow a public test price that anyone can move and swap through a test router, so every order type can be tried. These are not market prices.
        </span>
      </Notice>
      <button
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem(key(network), '1')
          setHidden(true)
        }}
        className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-mute hover:bg-raised hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
