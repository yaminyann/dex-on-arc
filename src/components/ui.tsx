import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import { clsx } from 'clsx'

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx('rounded-xl border border-line bg-panel', className)}>{children}</section>
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-raised', className)} />
}

type BtnVariant = 'primary' | 'ghost' | 'buy' | 'sell' | 'danger'

export function Button({
  variant = 'ghost',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean }) {
  const styles: Record<BtnVariant, string> = {
    primary: 'bg-accent text-accent-ink hover:opacity-90',
    buy: 'bg-up text-canvas hover:opacity-90',
    sell: 'bg-down text-canvas hover:opacity-90',
    ghost: 'border border-line text-ink hover:bg-raised',
    danger: 'border border-down/40 text-down hover:bg-down/10',
  }
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45',
        styles[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
}

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
    <div className={clsx('inline-flex rounded-lg border border-line bg-raised p-0.5', className)} role="tablist">
      {options.map((o) => (
        <button
          key={String(o.id)}
          role="tab"
          aria-selected={o.id === value}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          className={clsx(
            'min-h-[32px] flex-1 rounded-md px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
            o.id === value ? clsx('bg-panel shadow-sm', tone?.(o.id) ?? 'text-ink') : 'text-mute hover:text-ink',
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
      <span className="mb-1 flex items-center justify-between text-xs text-mute">
        <span>{label}</span>
        {hint && <span className="num">{hint}</span>}
      </span>
      <span
        className={clsx(
          'flex items-center rounded-lg border bg-raised px-3 focus-within:border-accent',
          error ? 'border-down/60' : 'border-line',
        )}
      >
        <input
          {...input}
          inputMode="decimal"
          autoComplete="off"
          className="num min-h-[42px] w-full bg-transparent text-sm text-ink outline-none placeholder:text-mute/60"
        />
        {right && <span className="ml-2 shrink-0 text-xs text-mute">{right}</span>}
      </span>
      {error && <span className="mt-1 block text-xs text-down">{error}</span>}
    </label>
  )
}

export function Row({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: 'up' | 'down' | 'mute' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-mute">{label}</span>
      <span className={clsx('num text-right', tone === 'up' && 'text-up', tone === 'down' && 'text-down', tone === 'mute' && 'text-mute')}>
        {value}
      </span>
    </div>
  )
}

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
  const color = tone === 'ok' ? 'text-up' : tone === 'error' ? 'text-down' : tone === 'warn' ? 'text-warn' : 'text-mute'
  return (
    <div className="flex gap-2.5 rounded-lg border border-line bg-raised/60 p-3 text-xs">
      <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', color)} />
      <div className="min-w-0 text-mute">
        {title && <div className="mb-0.5 font-medium text-ink">{title}</div>}
        {children}
      </div>
    </div>
  )
}

export function Badge({ children, tone = 'mute' }: { children: ReactNode; tone?: 'up' | 'down' | 'warn' | 'mute' | 'accent' }) {
  const tones = {
    up: 'bg-up/10 text-up',
    down: 'bg-down/10 text-down',
    warn: 'bg-warn/10 text-warn',
    mute: 'bg-raised text-mute',
    accent: 'bg-accent/15 text-accent',
  }
  return <span className={clsx('inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>{children}</span>
}

/** On/off switch with a label and optional hint. */
export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-3 py-1.5 text-left">
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-mute">{hint}</span>}
      </span>
      <span className={clsx('relative h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-line')}>
        <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-canvas transition-all', checked ? 'left-[1.1rem]' : 'left-0.5')} />
      </span>
    </button>
  )
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={clsx('max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-panel p-5 sm:rounded-2xl', wide ? 'max-w-xl' : 'max-w-md')}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-base font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded-md p-1.5 text-mute hover:bg-raised hover:text-ink">
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
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-sm text-xs text-mute">{children}</div>}
    </div>
  )
}
