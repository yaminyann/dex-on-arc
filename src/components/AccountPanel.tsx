import { ConnectKitButton } from 'connectkit'
import { ExternalLink } from 'lucide-react'
import type { NetworkConfig } from '@/trading/networks'
import { useAccountSummary } from '@/trading/account'
import { useSettings } from '@/trading/settings'
import { formatToken } from '@/trading/math'
import { Panel, Row, Skeleton } from './ui'
import { TokenBase } from './TokenIcon'

/** Compact account box beside the order form: value, free and escrowed USDC, PnL and what you hold. */
export function AccountPanel({ network }: { network: NetworkConfig }) {
  const a = useAccountSummary(network)
  const { setPage } = useSettings()
  const q = network.quote
  const usd = (v: bigint) => `${formatToken(v, q.decimals, 2)} USDC`
  const held = a.rows.filter((r) => r.available + r.locked > 0n && r.token.address !== q.address)

  return (
    <Panel className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-lg">Account</h3>
        <button onClick={() => setPage('dashboard')} className="min-h-[32px] text-xs font-bold underline underline-offset-2 hover:bg-accent hover:text-accent-ink">
          Dashboard
        </button>
      </div>

      {!a.connected ? (
        <div className="space-y-3 py-2 text-center">
          <p className="text-xs text-mute">Connect a wallet to see your balances and trade.</p>
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button onClick={show} className="press min-h-[44px] w-full border border-line bg-accent text-sm font-bold text-accent-ink shadow-hard-sm">
                Connect wallet
              </button>
            )}
          </ConnectKitButton.Custom>
        </div>
      ) : a.loading ? (
        <Skeleton className="h-24" />
      ) : (
        <>
          <div className="num sensitive text-2xl font-semibold">{usd(a.total)}</div>
          <div className="mb-2 text-[11px] text-mute">Account value{a.unpriced ? ` (${a.unpriced} unpriced token left out)` : ''}</div>
          <div className="sensitive divide-y divide-line/40">
            <Row label="Available" value={usd(a.available)} />
            <Row label="In orders" value={usd(a.locked)} />
            <Row label="Realized PnL" value={usd(a.realized)} tone={a.realized > 0n ? 'up' : a.realized < 0n ? 'down' : undefined} />
            <Row label="Unrealized PnL" value={usd(a.unrealized)} tone={a.unrealized > 0n ? 'up' : a.unrealized < 0n ? 'down' : undefined} />
          </div>
          {held.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
              {held.slice(0, 6).map((r) => (
                <li key={r.token.address} className="flex items-center gap-2 text-xs">
                  <TokenBase token={r.token} size={16} />
                  <span>{r.token.symbol}</span>
                  <span className="num ml-auto">{formatToken(r.available + r.locked, r.token.decimals, 6)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {network.isTestnet && (
        <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" className="press mt-3 flex min-h-[44px] items-center justify-center gap-1.5 border border-line bg-panel text-xs font-bold shadow-hard-sm hover:bg-raised">
          Get test USDC <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </Panel>
  )
}
