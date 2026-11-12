import { BRAND } from '@/brand'

/** The mark: an arch (the arc) over a square, on the accent fill with an ink border. */
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={`${BRAND.name} logo`} className="shrink-0">
      <rect x="1" y="1" width="30" height="30" fill="rgb(var(--accent))" stroke="rgb(var(--fg))" strokeWidth="2" />
      <path d="M7 24a9 9 0 0 1 18 0" fill="none" stroke="rgb(var(--accent-fg))" strokeWidth="3.4" />
      <rect x="13.5" y="10" width="5" height="5" fill="rgb(var(--accent-fg))" />
    </svg>
  )
}

export function Logo({ showName = true, size = 36 }: { showName?: boolean; size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      {showName && <span className="font-display text-xl leading-none">{BRAND.name}</span>}
    </span>
  )
}
