import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { TokenBase } from './TokenIcon'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import type { MarketState } from '@/trading/market'
import { useNowSeconds, type OracleState } from '@/trading/hooks'
import { formatPrice18 } from '@/trading/math'
import { fmtNum, fmtPct, priceFmt } from '@/trading/format'
import { Skeleton } from './ui'

export function TokenSelector({ network, value, onChange }: { network: NetworkConfig; value: TokenInfo | undefined; onChange: (t: TokenInfo) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const disabled = network.bases.length === 0
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className="flex min-h-[44px] items-center gap-2 rounded-lg border border-line bg-raised px-3 text-left hover:border-accent/50 disabled:opacity-60"
      >
        {value ? (
          <>
            <TokenBase token={value} />
            <span className="font-display text-base font-semibold">{value.symbol}</span>
            <span className="text-sm text-mute">/ {network.quote.symbol}</span>
          </>
        ) : (
          <span className="text-sm text-mute">No tokens configured</span>
        )}
        {!disabled && <ChevronDown className="h-4 w-4 text-mute" />}
      </button>
      {open && (
        <ul role="listbox" className="absolute left-0 top-full z-30 mt-1 min-w-[240px] rounded-xl border border-line bg-panel p-1 shadow-xl">
          {network.bases.map((t) => (
            <li key={t.address}>
              <button
                role="option"
                aria-selected={value?.address === t.address}
                onClick={() => {
                  onChange(t)
                  setOpen(false)
                }}
                className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-raised"
              >
                <TokenBase token={t} />
                <span className="font-medium">{t.symbol}</span>
                <span className="text-xs text-mute">{t.name}</span>
                {t.isTest && <span className="ml-auto rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn">TEST</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PairBar({ market, oracle, oracleLoading }: { market: MarketState; oracle: OracleState | undefined; oracleLoading: boolean }) {
  const s = market.stats
  const up = (s?.changePct ?? 0) >= 0
  const now = useNowSeconds()
  const age = oracle?.status === 'ok' ? Math.max(0, now - oracle.updatedAt) : null
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      <div>
        <div className="text-[11px] uppercase tracking-wider text-mute">Reference price</div>
        {market.loading && !s ? <Skeleton className="mt-1 h-7 w-28" /> : <div className="num font-display text-2xl font-semibold">{market.last ? priceFmt(market.last) : '-'}</div>}
      </div>
      <Stat label="24h change" value={s ? fmtPct(s.changePct) : '-'} tone={s ? (up ? 'up' : 'down') : undefined} />
      <Stat label="24h high" value={s ? priceFmt(s.high) : '-'} />
      <Stat label="24h low" value={s ? priceFmt(s.low) : '-'} />
      <Stat label="24h volume" value={s ? fmtNum(s.volume, 0) : '-'} />
      <div>
        <div className="text-[11px] uppercase tracking-wider text-mute">Onchain oracle</div>
        {oracleLoading ? (
          <Skeleton className="mt-1 h-5 w-24" />
        ) : oracle?.status === 'ok' ? (
          <div className="num text-sm">
            {formatPrice18(oracle.price18)} <span className="text-xs text-mute">{age !== null ? `${age < 90 ? `${age}s` : `${Math.round(age / 60)}m`} old` : ''}</span>
          </div>
        ) : (
          <div className="text-sm text-mute">
            {oracle?.status === 'no-feed' && 'No feed on contract'}
            {oracle?.status === 'unavailable' && oracle.message}
            {oracle?.status === 'no-contract' && 'Contract not configured'}
            {!oracle && '-'}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-mute">{label}</div>
      <div className={`num text-sm ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>{value}</div>
    </div>
  )
}
