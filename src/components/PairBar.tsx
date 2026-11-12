import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { TokenBase } from './TokenIcon'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import type { MarketState } from '@/trading/market'
import { useNowSeconds, type OracleState } from '@/trading/hooks'
import { formatPrice18 } from '@/trading/math'
import { fmtNum, fmtPct, priceFmt } from '@/trading/format'
import { Skeleton } from './ui'

export function TokenSelector({ network, bases, value, onChange }: { network: NetworkConfig; bases: TokenInfo[]; value: TokenInfo | undefined; onChange: (t: TokenInfo) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchable = bases.length > 8
  const needle = query.trim().toLowerCase()
  const shown = needle ? bases.filter((t) => t.symbol.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle) || t.address.toLowerCase() === needle) : bases
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const disabled = bases.length <= 1
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className="press flex min-h-[48px] items-center gap-2 border border-line bg-panel px-3 text-left shadow-hard-sm enabled:hover:bg-raised disabled:cursor-default"
      >
        {value ? (
          <>
            <TokenBase token={value} />
            <span className="font-display text-lg">{value.symbol}</span>
            <span className="text-sm text-mute">/ {network.quote.symbol}</span>
          </>
        ) : (
          <span className="text-sm text-mute">No tokens configured</span>
        )}
        {!disabled && <ChevronDown className="h-4 w-4 text-mute" />}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel p-1 shadow-xl">
          {searchable && (
            <label className="mb-1 flex items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
              <Search className="h-3.5 w-3.5 text-mute" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${bases.length} tokens`}
                aria-label="Search tokens"
                className="min-h-[36px] w-full bg-transparent text-sm outline-none placeholder:text-mute/60"
              />
            </label>
          )}
        <ul role="listbox" className="thin-scroll max-h-72 overflow-y-auto">
          {shown.length === 0 && <li className="px-3 py-4 text-center text-xs text-mute">No token matches "{query}".</li>}
          {shown.map((t) => (
            <li key={t.address}>
              <button
                role="option"
                aria-selected={value?.address === t.address}
                onClick={() => {
                  onChange(t)
                  setOpen(false)
                  setQuery('')
                }}
                className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-raised"
              >
                <TokenBase token={t} />
                <span className="font-medium">{t.symbol}</span>
                <span className="min-w-0 truncate text-xs text-mute">{t.name}</span>
                {t.isTest ? (
                  <span className="ml-auto border border-line bg-warn px-1.5 py-0.5 font-mono text-[10px] font-semibold text-canvas">TEST</span>
                ) : (
                  <span className="num ml-auto shrink-0 text-[10px] text-mute/70" title={t.address}>{t.address.slice(0, 6)}…{t.address.slice(-4)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        </div>
      )}
    </div>
  )
}

export function PairBar({ market, oracle, oracleLoading, indicative, hasReference }: { market: MarketState; oracle: OracleState | undefined; oracleLoading: boolean; indicative?: { price18: bigint | null; loading: boolean }; hasReference: boolean }) {
  const s = market.stats
  const up = (s?.changePct ?? 0) >= 0
  const now = useNowSeconds()
  const age = oracle?.status === 'ok' ? Math.max(0, now - oracle.updatedAt) : null
  // Tokens without a Coinbase market show the aggregator's price for a small trade instead of empty stats.
  const showMarket = hasReference
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      {showMarket ? (
        <>
          <div>
            <div className="text-xs font-semibold text-mute">Reference price</div>
            {market.loading && !s ? <Skeleton className="mt-1 h-7 w-28" /> : <div className="num text-2xl font-semibold">{market.last ? priceFmt(market.last) : '-'}</div>}
          </div>
          <Stat label="24h change" value={s ? fmtPct(s.changePct) : '-'} tone={s ? (up ? 'up' : 'down') : undefined} />
          <Stat label="24h high" value={s ? priceFmt(s.high) : '-'} />
          <Stat label="24h low" value={s ? priceFmt(s.low) : '-'} />
          <Stat label="24h volume" value={s ? fmtNum(s.volume, 0) : '-'} />
        </>
      ) : (
        <div>
          <div className="text-xs font-semibold text-mute">Swap price (10 USDC)</div>
          {indicative?.loading ? <Skeleton className="mt-1 h-7 w-28" /> : <div className="num text-2xl font-semibold">{indicative?.price18 ? formatPrice18(indicative.price18, 6) : 'No route'}</div>}
        </div>
      )}
      <div className={oracle?.status === 'no-contract' || (!showMarket && oracle?.status !== 'ok') ? 'hidden' : ''}>
        <div className="text-xs font-semibold text-mute">Onchain oracle</div>
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
      <div className="text-xs font-semibold text-mute">{label}</div>
      <div className={`num text-sm ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>{value}</div>
    </div>
  )
}
