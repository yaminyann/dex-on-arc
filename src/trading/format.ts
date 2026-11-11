export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`
}

export function fmtUsd(n: number, fraction = 2): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: fraction, minimumFractionDigits: fraction }).format(n)
}

export function fmtNum(n: number, fraction = 2): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: fraction }).format(n)
}

export function fmtPct(n: number, fraction = 2): string {
  const s = (n * 100).toFixed(fraction)
  return `${n > 0 ? '+' : ''}${s}%`
}

export function fmtDateTime(unixSeconds: number): string {
  if (!unixSeconds) return '-'
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return 'now'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${Math.max(1, m)}m`
}

export function priceFmt(n: number): string {
  if (n >= 1000) return fmtNum(n, 2)
  if (n >= 1) return fmtNum(n, 4)
  return fmtNum(n, 6)
}
