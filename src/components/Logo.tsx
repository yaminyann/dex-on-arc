import { BRAND } from '@/brand'

/** The mark: an arch (the arc) with a rising point. It takes the accent colour, so it follows the theme. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={`${BRAND.name} logo`}>
      <rect width="32" height="32" rx="9" fill="rgb(var(--accent))" />
      <path d="M7 23.5a9 9 0 0 1 18 0" fill="none" stroke="rgb(var(--accent-fg))" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="16" cy="12.2" r="2.5" fill="rgb(var(--accent-fg))" />
    </svg>
  )
}

export function Logo({ showName = true }: { showName?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      {showName && <span className="font-display text-[17px] font-semibold tracking-tight">{BRAND.name}</span>}
    </span>
  )
}
