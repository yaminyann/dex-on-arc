import { useState, type ReactNode } from 'react'
import { Github, Send } from 'lucide-react'
import { BRAND } from '@/brand'
import { NETWORKS } from '@/trading/networks'
import { useSettings } from '@/trading/settings'
import { useBackendHealth } from '@/trading/hooks'
import { Logo } from './Logo'
import { Modal } from './ui'

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

function Social({ href, label, children }: { href: string | undefined; label: string; children: ReactNode }) {
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label} className="grid h-8 w-8 place-items-center rounded-md text-mute transition hover:bg-raised hover:text-ink">
      {children}
    </a>
  )
}

function FooterLink({ href, children, onClick }: { href?: string; children: ReactNode; onClick?: () => void }) {
  const cls = 'text-xs text-mute transition hover:text-ink'
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {children}
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  )
}

/** Platform footer: live status, links, socials and the risk notice. Links appear only when configured. */
export function Footer() {
  const { networkKey } = useSettings()
  const health = useBackendHealth()
  const [legal, setLegal] = useState<'risk' | 'terms' | 'privacy' | null>(null)
  const net = NETWORKS[networkKey]
  const online = health.isSuccess
  const keeper = health.data?.keeper

  return (
    <footer className="mt-10 border-t border-line">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-3 pb-20 pt-5 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Logo />
          <span className="hidden text-xs text-mute md:inline">{BRAND.tagline}</span>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            <FooterLink href={BRAND.links.docs}>Docs</FooterLink>
            {BRAND.links.support && <FooterLink href={BRAND.links.support}>Support</FooterLink>}
            <FooterLink href={BRAND.links.terms} onClick={() => setLegal('terms')}>
              Terms
            </FooterLink>
            <FooterLink href={BRAND.links.privacy} onClick={() => setLegal('privacy')}>
              Privacy
            </FooterLink>
            <FooterLink onClick={() => setLegal('risk')}>Risk</FooterLink>
            <div className="flex items-center">
              <Social href={BRAND.links.x} label="X">
                <XIcon />
              </Social>
              <Social href={BRAND.links.discord} label="Discord">
                <DiscordIcon />
              </Social>
              <Social href={BRAND.links.telegram} label="Telegram">
                <Send className="h-4 w-4" />
              </Social>
              <Social href={BRAND.links.github} label="GitHub">
                <Github className="h-4 w-4" />
              </Social>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3 text-[11px] text-mute">
          <span className="flex items-center gap-1.5" title={online ? 'The backend answers' : 'The backend is not reachable'}>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-up' : 'bg-down'}`} />
            {online ? 'Online' : 'Backend offline'}
          </span>
          <span>{net.label}</span>
          <span className="flex items-center gap-1.5" title="Executes your orders and DCA plans">
            <span className={`h-1.5 w-1.5 rounded-full ${keeper?.running ? 'bg-up' : 'bg-mute/50'}`} />
            Keeper {keeper?.running ? 'running' : 'not running'}
          </span>
          <span className="ml-auto">
            Non-custodial. Your funds stay in your wallet or in the order contract, never with {BRAND.name}. Not financial advice.
          </span>
        </div>
      </div>

      <Modal open={legal !== null} onClose={() => setLegal(null)} title={legal === 'terms' ? 'Terms of use' : legal === 'privacy' ? 'Privacy' : 'Risk disclosure'} wide>
        <div className="space-y-3 text-sm text-mute">
          {legal === 'risk' && (
            <>
              <p>Trading digital assets can lose all of its value. Prices move fast and orders can fill at worse prices than expected.</p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>The order contract is unaudited software on a young chain. Funds escrowed in it can be lost to bugs.</li>
                <li>Stop-loss and trailing orders follow a price oracle that can lag the market. A triggered order is not guaranteed to fill.</li>
                <li>Orders run only when a keeper submits them. If no keeper runs, nothing happens until one does.</li>
                <li>Tokens in the list are routable, not endorsed. Anyone can create a token; many are worthless or hostile.</li>
                <li>The Agent Station turns text into transactions. Read each confirmation, and set limits you can afford.</li>
                <li>Testnet assets have no value and testnet prices are not market prices.</li>
              </ul>
            </>
          )}
          {legal === 'terms' && (
            <>
              <p>
                {BRAND.name} is software that helps you send transactions from your own wallet. It does not hold your keys or your funds and is not a broker, exchange or adviser.
              </p>
              <p>You are responsible for your transactions, for complying with the laws that apply to you, and for the tokens you choose to trade. The software is provided as is, without warranty.</p>
              <p className="rounded-lg border border-warn/40 p-3 text-xs">This is a plain-language placeholder. Have a lawyer replace it, then set VITE_TERMS_URL so this link opens your real terms.</p>
            </>
          )}
          {legal === 'privacy' && (
            <>
              <p>The app stores your settings and recent agent messages in your browser only. It reads public blockchain data for your wallet address.</p>
              <p>Quote requests, token lists and chart data go through this site's backend and to third parties (KyberSwap, Coinbase market data, the RPC provider), which see your IP address and the request.</p>
              <p className="rounded-lg border border-warn/40 p-3 text-xs">This is a plain-language placeholder. Have a lawyer replace it, then set VITE_PRIVACY_URL so this link opens your real policy.</p>
            </>
          )}
        </div>
      </Modal>
    </footer>
  )
}
