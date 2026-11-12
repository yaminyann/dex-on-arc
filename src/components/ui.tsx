import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import { clsx } from 'clsx'

/** A bordered block. `raised` adds the hard shadow, for the one featured block on a screen. */
export function Panel({ className, children, raised }: { className?: string; children: ReactNode; raised?: boolean }) {
  return <section className={clsx('border border-line bg-panel', raised && 'shadow-hard', className)}>{children}</section>
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse bg-raised', className)} aria-hidden="true" />
}

type BtnVariant = 'primary' | 'ghost' | 'buy' | 'sell' | 'danger'

/** Flat fill, 2px ink border, hard shadow that the button sinks into when pressed. */
export function Button({
  variant = 'ghost',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean }) {
  const styles: Record<BtnVariant, string> = {
    primary: 'bg-accent text-accent-ink',
    ghost: 'bg-panel text-ink hover:bg-raised',
    buy: 'bg-up text-canvas',
    sell: 'bg-down text-canvas',
    danger: 'bg-panel text-down hover:bg-raised',
  }
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'press inline-flex min-h-[44px] items-center justify-center gap-2 border border-line px-4 text-sm font-bold shadow-hard-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
        styles[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
}

/** Tabs that read as one bordered strip. The active tab is the accent fill. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  tone,
  className,
}: {
  value: T
  options: { id: T; label: string; disabled?: boolean }[]
  onChange: (v: T) => void
  tone?: (v: T) => string
  className?: string
}) {
  return (
    <div className={clsx('inline-flex border border-line bg-panel', className)} role="tablist">
      {options.map((o, i) => (
        <button
          key={String(o.id)}
          role="tab"
          aria-selected={o.id === value}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          className={clsx(
            'min-h-[40px] flex-1 px-3 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40',
            i > 0 && 'border-l border-line',
            o.id === value ? clsx('bg-accent text-accent-ink') : clsx('bg-panel hover:bg-raised', tone?.(o.id) ?? 'text-ink'),
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({
  label,
  hint,
  right,
  error,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; right?: ReactNode; error?: string | null }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold">
        <span>{label}</span>
        {hint && <span className="num text-mute">{hint}</span>}
      </span>
      {/* The wrapper draws the focus outline, so the bare input can hide its own. */}
      <span className={clsx('flex items-center border bg-panel px-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink', error ? 'border-down' : 'border-line')}>
        <input {...input} inputMode="decimal" autoComplete="off" className="num min-h-[44px] w-full bg-transparent text-sm text-ink outline-none placeholder:text-mute" />
        {right && <span className="ml-2 shrink-0 text-xs font-semibold text-mute">{right}</span>}
      </span>
      {error && <span className="mt-1 block text-xs font-semibold text-down">{error}</span>}
    </label>
  )
}

export function Row({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: 'up' | 'down' | 'mute' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
      <span className="text-mute">{label}</span>
      <span className={clsx('num text-right', tone === 'up' && 'text-up', tone === 'down' && 'text-down', tone === 'mute' && 'text-mute')}>{value}</span>
    </div>
  )
}

/** A message block. The icon is paired with text, so meaning never rests on colour alone. */
export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok'
  title?: string
  children?: ReactNode
}) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle
  const color = tone === 'ok' ? 'text-up' : tone === 'error' ? 'text-down' : tone === 'warn' ? 'text-warn' : 'text-ink'
  return (
    <div className="flex gap-2.5 border border-line bg-raised p-3 text-xs">
      <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', color)} />
      <div className="min-w-0">
        {title && <div className="mb-0.5 font-bold">{title}</div>}
        <div className="text-mute">{children}</div>
      </div>
    </div>
  )
}

/** A square status tag. Use it only for a real state or label. */
export function Badge({ children, tone = 'mute' }: { children: ReactNode; tone?: 'up' | 'down' | 'warn' | 'mute' | 'accent' }) {
  const tones = {
    up: 'bg-up text-canvas',
    down: 'bg-down text-canvas',
    warn: 'bg-warn text-canvas',
    mute: 'bg-raised text-ink',
    accent: 'bg-accent text-accent-ink',
  }
  return <span className={clsx('inline-flex items-center border border-line px-1.5 py-0.5 font-mono text-[11px] font-semibold', tones[tone])}>{children}</span>
}

/** On/off switch with a label and optional hint. */
export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex min-h-[44px] w-full items-center justify-between gap-3 py-1.5 text-left">
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        {hint && <span className="block text-xs text-mute">{hint}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="num w-7 text-right text-[11px] font-semibold text-mute">{checked ? 'On' : 'Off'}</span>
        <span className={clsx('relative h-6 w-11 border border-line', checked ? 'bg-accent' : 'bg-panel')}>
          <span className={clsx('absolute top-0.5 h-4 w-4 border border-line bg-ink transition-all', checked ? 'left-[1.45rem]' : 'left-0.5')} />
        </span>
      </span>
    </button>
  )
}

/** Dialog. Escape and the close button end it, focus moves in and returns, and the page behind stays put. */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const shell = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    shell.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        ref={shell}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={clsx('max-h-[92dvh] w-full overflow-y-auto border border-line bg-panel p-5 shadow-hard-lg', wide ? 'max-w-xl' : 'max-w-md')}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="press grid h-11 w-11 place-items-center border border-line bg-panel shadow-hard-sm hover:bg-raised">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
      <div className="text-sm font-bold">{title}</div>
      {children && <div className="max-w-sm text-xs text-mute">{children}</div>}
    </div>
  )
}
