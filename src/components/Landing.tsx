import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeftRight, ArrowRight, BookOpen, CalendarClock, ChevronDown, Clock3, Layers, ShieldCheck, Sparkles, Wallet } from 'lucide-react'
import { clsx } from 'clsx'
import { BRAND } from '@/brand'
import { fetchTokenList } from '@/trading/tokens'
import { useBackendHealth } from '@/trading/hooks'
import { useSettings } from '@/trading/settings'
import { Reveal } from './motion'
import { TokenBase } from './TokenIcon'

// ---------- small pieces ----------

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-accent">{children}</div>
}

function SectionTitle({ eyebrow, title, body }: { eyebrow: string; title: ReactNode; body?: string }) {
  return (
    <Reveal className="mx-auto mb-10 max-w-2xl text-center">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      {body && <p className="mt-3 text-sm text-mute sm:text-base">{body}</p>}
    </Reveal>
  )
}

function PrimaryButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="gradient-bg group inline-flex min-h-[48px] items-center gap-2 rounded-xl px-6 text-sm font-semibold text-accent-ink shadow-lg shadow-accent/25 hover:brightness-110 active:scale-[0.98]">
      {children}
      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

function GhostButton({ children, onClick, href }: { children: ReactNode; onClick?: () => void; href?: string }) {
  const cls = 'glass inline-flex min-h-[48px] items-center gap-2 rounded-xl px-6 text-sm font-medium hover:border-accent/50 active:scale-[0.98]'
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {children}
    </a>
  ) : (
    <button onClick={onClick} className={cls}>
      {children}
    </button>
  )
}

// ---------- hero illustration ----------

/** A repeatable pseudo-random series so the illustration is the same on every load. */
function candles(n: number) {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  let price = 48
  const out: { o: number; c: number; h: number; l: number }[] = []
  for (let i = 0; i < n; i++) {
    const o = price
    const c = o + (rand() - 0.42) * 9
    out.push({ o, c, h: Math.max(o, c) + rand() * 4, l: Math.min(o, c) - rand() * 4 })
    price = c
  }
  return out
}

function ProductIllustration() {
  const { animate } = useSettings()
  const data = useMemo(() => candles(30), [])
  const min = Math.min(...data.map((d) => d.l))
  const max = Math.max(...data.map((d) => d.h))
  const y = (v: number) => 12 + (1 - (v - min) / (max - min)) * 196
  const w = 600 / data.length
  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${(i * w + w / 2).toFixed(1)} ${y(d.c).toFixed(1)}`).join(' ')

  return (
    <div className="relative">
      <div className="glass glow overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-down/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-up/70" />
          <span className="ml-3 text-xs text-mute">tBTC / USDC</span>
          <span className="ml-auto rounded-md bg-raised px-2 py-0.5 text-[10px] uppercase tracking-wider text-mute">Illustration</span>
        </div>
        <div className="grid gap-0 sm:grid-cols-[1fr_170px]">
          <div className="p-3 sm:p-4">
            <svg viewBox="0 0 600 220" className="h-auto w-full" role="img" aria-label="Illustrative price chart">
              <defs>
                <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="rgb(var(--accent))" stopOpacity="0.28" />
                  <stop offset="1" stopColor="rgb(var(--accent))" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[0.2, 0.4, 0.6, 0.8].map((g) => (
                <line key={g} x1="0" x2="600" y1={g * 220} y2={g * 220} stroke="rgb(var(--line))" strokeOpacity="0.5" strokeDasharray="3 6" />
              ))}
              <path d={`${line} L600 220 L0 220 Z`} fill="url(#area)" />
              {data.map((d, i) => {
                const up = d.c >= d.o
                const color = up ? 'rgb(var(--up))' : 'rgb(var(--down))'
                const x = i * w + w / 2
                return (
                  <motion.g key={i} initial={animate ? { opacity: 0, scaleY: 0.2 } : false} animate={{ opacity: 1, scaleY: 1 }} transition={{ delay: animate ? 0.4 + i * 0.03 : 0, duration: 0.4 }} style={{ transformOrigin: `${x}px ${y((d.o + d.c) / 2)}px` }}>
                    <line x1={x} x2={x} y1={y(d.h)} y2={y(d.l)} stroke={color} strokeWidth="1.4" />
                    <rect x={x - w * 0.27} y={Math.min(y(d.o), y(d.c))} width={w * 0.54} height={Math.max(3, Math.abs(y(d.o) - y(d.c)))} rx="1.5" fill={color} />
                  </motion.g>
                )
              })}
              <motion.path d={line} fill="none" stroke="rgb(var(--accent))" strokeWidth="2" strokeLinecap="round" initial={animate ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={{ duration: 1.8, delay: 0.3, ease: 'easeInOut' }} />
              <line x1="0" x2="600" y1={y(min + (max - min) * 0.18)} y2={y(min + (max - min) * 0.18)} stroke="rgb(var(--down))" strokeDasharray="5 5" strokeOpacity="0.9" />
              <text x="8" y={y(min + (max - min) * 0.18) - 6} fontSize="11" fill="rgb(var(--down))">
                stop-loss
              </text>
            </svg>
          </div>
          <div className="hidden border-l border-line p-4 sm:block">
            <div className="mb-3 flex gap-1 text-[11px]">
              <span className="flex-1 rounded-md bg-up/15 py-1 text-center font-semibold text-up">Buy</span>
              <span className="flex-1 rounded-md py-1 text-center text-mute">Sell</span>
            </div>
            <div className="space-y-2 text-[11px]">
              <div className="rounded-lg border border-line bg-raised px-2.5 py-2">
                <div className="text-mute">Spend</div>
                <div className="num text-sm">250.00 USDC</div>
              </div>
              <div className="flex justify-between text-mute">
                <span>Route</span>
                <span className="text-ink">aggregator</span>
              </div>
              <div className="flex justify-between text-mute">
                <span>Slippage</span>
                <span className="text-ink">0.50%</span>
              </div>
              <div className="gradient-bg rounded-lg py-2 text-center text-xs font-semibold text-accent-ink">Buy tBTC</div>
            </div>
          </div>
        </div>
      </div>
      <div className={clsx('absolute -bottom-6 -left-2 hidden w-56 sm:block', animate && 'anim-float')}>
        <div className="glass rounded-xl p-3 text-[11px] shadow-xl">
          <div className="flex items-center gap-1.5 font-medium">
            <Sparkles className="h-3.5 w-3.5 text-accent" /> Agent
          </div>
          <div className="mt-1.5 text-mute">&ldquo;stop loss 0.5 tBTC at 80000&rdquo;</div>
          <div className="mt-1.5 text-up">Is this exactly what you want?</div>
        </div>
      </div>
    </div>
  )
}

// ---------- hero ----------

function Hero({ onTrade, onAgent }: { onTrade: () => void; onAgent: () => void }) {
  const health = useBackendHealth()
  const tokens = useQuery({ queryKey: ['landing-tokens'], queryFn: () => fetchTokenList(5042), staleTime: 10 * 60_000, retry: 1 })
  const count = tokens.data ? Math.max(0, tokens.data.length - 1) : null
  const keeper = health.data?.keeper
  const stats: { value: string; label: string }[] = [
    { value: count === null ? '—' : String(count), label: 'tokens routable on Arc' },
    { value: '6 + DCA', label: 'order types, one contract' },
    { value: '≤ 0.10%', label: 'keeper fee, lower-only' },
    { value: 'No custody', label: 'escrow rules in code, no deposits to us' },
  ]

  return (
    <section className="relative isolate overflow-hidden px-1 pb-20 pt-10 sm:pt-16">
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <div className="anim-drift-a absolute -left-24 -top-24 h-[420px] w-[420px] rounded-full bg-accent/25 blur-[110px]" />
        <div className="anim-drift-b absolute -right-24 top-10 h-[380px] w-[380px] rounded-full bg-accent2/20 blur-[110px]" />
        <div className="grid-lines absolute inset-0" />
      </div>

      <div className="mx-auto grid max-w-[1200px] items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <Reveal y={14}>
            <span className="glass inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs">
              <span className="relative flex h-2 w-2">
                <span className={clsx('anim-ping absolute inline-flex h-full w-full rounded-full', health.isSuccess ? 'bg-up' : 'bg-down')} />
                <span className={clsx('relative inline-flex h-2 w-2 rounded-full', health.isSuccess ? 'bg-up' : 'bg-down')} />
              </span>
              {health.isSuccess ? 'Live on Arc' : 'Connecting to the backend'}
              {keeper?.running && <span className="text-mute">· keeper running</span>}
            </span>
          </Reveal>
          <Reveal delay={0.08}>
            <h1 className="mt-6 font-display text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
              Trade. Automate.
              <br />
              <span className="gradient-text">Command.</span>
            </h1>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="mt-6 max-w-xl text-base text-mute sm:text-lg">
              {BRAND.name} is a non-custodial terminal for Arc. Swap through the best aggregator route, escrow limit, stop and DCA orders that run while you sleep, and tell the agent what you want in plain words.
            </p>
          </Reveal>
          <Reveal delay={0.24} className="mt-8 flex flex-wrap gap-3">
            <PrimaryButton onClick={onTrade}>Launch app</PrimaryButton>
            <GhostButton onClick={onAgent}>
              <Sparkles className="h-4 w-4 text-accent" /> Try the Agent
            </GhostButton>
          </Reveal>
          <Reveal delay={0.32} className="mt-10 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label}>
                <div className="num font-display text-xl font-semibold sm:text-2xl">{s.value}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-mute">{s.label}</div>
              </div>
            ))}
          </Reveal>
        </div>
        <Reveal delay={0.2} y={30}>
          <ProductIllustration />
        </Reveal>
      </div>
    </section>
  )
}

// ---------- token marquee ----------

function TokenMarquee() {
  const tokens = useQuery({ queryKey: ['landing-tokens'], queryFn: () => fetchTokenList(5042), staleTime: 10 * 60_000, retry: 1 })
  const list = (tokens.data ?? []).filter((t) => t.symbol !== 'USDC').slice(0, 24)
  if (list.length === 0) return null
  const row = [...list, ...list]
  return (
    <Reveal className="mb-20">
      <div className="mb-4 text-center text-xs uppercase tracking-[0.18em] text-mute">Routable on Arc through the aggregator</div>
      <div className="marquee-mask overflow-hidden">
        <div className="anim-marquee flex w-max gap-3">
          {row.map((t, i) => (
            <span key={`${t.address}-${i}`} className="glass flex shrink-0 items-center gap-2 rounded-full py-1.5 pl-2 pr-4 text-sm">
              <TokenBase token={{ symbol: t.symbol, logoURI: t.logoURI }} size={20} />
              {t.symbol}
            </span>
          ))}
        </div>
      </div>
    </Reveal>
  )
}

// ---------- features ----------

const FEATURES = [
  { icon: ArrowLeftRight, title: 'Best-route swaps', body: 'Quotes from every aggregator are ranked by the guaranteed output after gas. A failing provider is skipped, never trusted.' },
  { icon: Layers, title: 'Orders that wait for you', body: 'Limit, stop-loss, take-profit, stop-limit, trailing stop and OCO. Your funds sit in escrow and a keeper executes when the price is hit.' },
  { icon: CalendarClock, title: 'Recurring buys', body: 'Schedule a DCA by the hour, day, week or month with an optional price cap. Pause, resume or cancel and take back the rest.' },
  { icon: Sparkles, title: 'Agent Station', body: 'Type "buy 10 USDC of tBTC". It reads the exact terms back, waits for your yes, then sends. Grant permission once, inside limits you set.' },
  { icon: ShieldCheck, title: 'Non-custodial escrow', body: 'Escrow can only leave to you, to the keeper fee, or to an exact-amount swap. The owner cannot withdraw it, and there is no upgrade path.' },
  { icon: Clock3, title: 'Transparent controls', body: 'Feed and router changes are timelocked and public before they apply. Pausing never blocks a refund or a cancel.' },
] as const

function Features() {
  return (
    <section className="mx-auto mb-24 max-w-[1200px]">
      <SectionTitle eyebrow="What you get" title={<>Everything a serious terminal needs, <span className="gradient-text">on Arc</span></>} body="One interface for swaps, protective orders and automation, built so your funds stay yours." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={(i % 3) * 0.07}>
            <div className="glass lift h-full rounded-2xl p-6">
              <span className="gradient-bg grid h-11 w-11 place-items-center rounded-xl text-accent-ink">
                <f.icon className="h-5 w-5" />
              </span>
              <h3 className="mt-5 font-display text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-mute">{f.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

// ---------- how it works ----------

const STEPS = [
  { icon: Wallet, title: 'Connect your wallet', body: 'Your keys never leave it. Pick Arc mainnet, or Arc Testnet to rehearse with test tokens.' },
  { icon: Sparkles, title: 'Choose or command', body: 'Use the order forms, or tell the agent in one line. Every action is read back with exact numbers first.' },
  { icon: Layers, title: 'A keeper executes', body: 'Orders run when their condition is met, even with your browser closed. You can cancel and refund at any time.' },
] as const

function HowItWorks() {
  return (
    <section className="mx-auto mb-24 max-w-[1200px]">
      <SectionTitle eyebrow="How it works" title="Three steps, nothing hidden" />
      <div className="relative grid gap-4 md:grid-cols-3">
        <div className="absolute left-[16%] right-[16%] top-[3.1rem] hidden h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent md:block" aria-hidden="true" />
        {STEPS.map((s, i) => (
          <Reveal key={s.title} delay={i * 0.1}>
            <div className="glass relative h-full rounded-2xl p-6 text-center">
              <span className="gradient-bg relative mx-auto grid h-14 w-14 place-items-center rounded-2xl text-accent-ink shadow-lg shadow-accent/30">
                <s.icon className="h-6 w-6" />
                <span className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full border border-line bg-panel text-[11px] font-semibold text-ink">{i + 1}</span>
              </span>
              <h3 className="mt-5 font-display text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-mute">{s.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

// ---------- agent demo ----------

const DEMO_COMMAND = 'stop loss 0.5 tBTC at 80000'
const DEMO_LINES: [string, string][] = [
  ['Action', 'Stop-loss sell tBTC'],
  ['Escrowed now', '0.5 tBTC'],
  ['Sells when price falls to', '80,000 USDC'],
  ['Max slippage', '0.50%'],
]

type DemoStep = 'typing' | 'readback' | 'yes' | 'done'

function AgentDemo() {
  const { animate } = useSettings()
  const [typed, setTyped] = useState(animate ? 0 : DEMO_COMMAND.length)
  const [step, setStep] = useState<DemoStep>(animate ? 'typing' : 'done')

  useEffect(() => {
    if (!animate) return
    const timers: ReturnType<typeof setTimeout>[] = []
    let cancelled = false
    const cycle = () => {
      if (cancelled) return
      setTyped(0)
      setStep('typing')
      for (let i = 1; i <= DEMO_COMMAND.length; i++) timers.push(setTimeout(() => !cancelled && setTyped(i), 600 + i * 55))
      const t = 600 + DEMO_COMMAND.length * 55
      timers.push(setTimeout(() => setStep('readback'), t + 500))
      timers.push(setTimeout(() => setStep('yes'), t + 2600))
      timers.push(setTimeout(() => setStep('done'), t + 3400))
      timers.push(setTimeout(cycle, t + 7200))
    }
    cycle()
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [animate])

  const showReadback = step !== 'typing'
  return (
    <div className="glass glow rounded-2xl p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2 border-b border-line pb-3 text-sm font-medium">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent/15 text-accent">
          <Sparkles className="h-4 w-4" />
        </span>
        Agent Station
        <span className="ml-auto rounded-md bg-raised px-2 py-0.5 text-[10px] uppercase tracking-wider text-mute">Demo</span>
      </div>
      <div className="min-h-[300px] space-y-3">
        <div className="flex justify-end">
          <div className="gradient-bg max-w-[88%] rounded-2xl px-3.5 py-2 text-sm text-accent-ink">
            {DEMO_COMMAND.slice(0, typed)}
            {step === 'typing' && <span className="anim-caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-current" />}
          </div>
        </div>
        <AnimatePresence>
          {showReadback && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="max-w-[94%] rounded-2xl border border-line bg-raised px-3.5 py-3 text-sm">
              <div className="font-medium">Is this exactly what you want?</div>
              <div className="mt-2 divide-y divide-line rounded-lg border border-line bg-panel/60 px-3">
                {DEMO_LINES.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 py-1.5 text-xs">
                    <span className="text-mute">{k}</span>
                    <span className="num text-right">{v}</span>
                  </div>
                ))}
              </div>
              {step === 'readback' && (
                <div className="mt-3 flex gap-2">
                  <span className="gradient-bg flex-1 rounded-lg py-2 text-center text-xs font-semibold text-accent-ink">Yes, run it</span>
                  <span className="flex-1 rounded-lg border border-line py-2 text-center text-xs text-mute">Cancel</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {(step === 'yes' || step === 'done') && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex justify-end">
              <div className="gradient-bg rounded-2xl px-3.5 py-2 text-sm text-accent-ink">yes</div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {step === 'done' && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-[94%] rounded-2xl border border-up/40 bg-up/10 px-3.5 py-2.5 text-sm text-up">
              Order created. It runs when a keeper submits it, even with this tab closed.
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function AgentSection({ onAgent }: { onAgent: () => void }) {
  const points = ['Plain commands: buy, sell, limit, stop-loss, take-profit, trailing, OCO, DCA, cancel', 'Built from live balances, oracle price and a real quote', 'One permission, with per-command and daily limits you choose', 'Your wallet still signs every transaction']
  return (
    <section className="mx-auto mb-24 grid max-w-[1200px] items-center gap-12 lg:grid-cols-2">
      <Reveal>
        <Eyebrow>Agent Station</Eyebrow>
        <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Say it once. <span className="gradient-text">Confirm it exactly.</span>
        </h2>
        <p className="mt-4 text-sm text-mute sm:text-base">It is a command interpreter, not a guessing chatbot: the same words always mean the same thing, and anything unclear is refused with an example.</p>
        <ul className="mt-6 space-y-3">
          {points.map((p) => (
            <li key={p} className="flex gap-3 text-sm">
              <span className="gradient-bg mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-accent-ink">
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 6.2l2.4 2.4 4.6-5" />
                </svg>
              </span>
              {p}
            </li>
          ))}
        </ul>
        <div className="mt-8">
          <PrimaryButton onClick={onAgent}>Open the Agent</PrimaryButton>
        </div>
      </Reveal>
      <Reveal delay={0.12}>
        <AgentDemo />
      </Reveal>
    </section>
  )
}

// ---------- security ----------

const SECURITY = [
  { title: 'Escrow rules in code', body: 'Funds leave the order contract only to the owner, the keeper fee, or an allowlisted swap for the exact amount, checked against the contract\'s own oracle price.' },
  { title: 'Timelocked changes', body: 'New feeds and routers are queued and public before they apply. Disabling is instant. The keeper fee can only be lowered.' },
  { title: 'Pause that never traps you', body: 'Pausing stops new orders and executions. Cancels, refunds and expiries always keep working.' },
  { title: 'Honest about risk', body: 'The contract is unaudited and young. Stops follow an oracle that can lag, and a triggered order is not guaranteed to fill. Read the risk notice.' },
] as const

function Security() {
  return (
    <section className="mx-auto mb-24 max-w-[1200px]">
      <SectionTitle eyebrow="Security" title="Built to be checked, not trusted" body="Every control is a contract call anyone can read, and every owner action is public." />
      <div className="grid gap-4 sm:grid-cols-2">
        {SECURITY.map((s, i) => (
          <Reveal key={s.title} delay={(i % 2) * 0.08}>
            <div className="glass lift flex h-full gap-4 rounded-2xl p-6">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div>
                <h3 className="font-display text-base font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm text-mute">{s.body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

// ---------- faq ----------

const FAQ = [
  { q: 'Do you hold my funds?', a: 'No. Swaps go from your wallet through an aggregator router. Orders and DCA plans are escrowed in a smart contract that only you can cancel, and that pays out only by its own rules. There is no custodian and no deposit to us.' },
  { q: 'Who executes my orders?', a: 'Any keeper. Execution is open to everyone and pays a small keeper fee (at most 0.10% of the output). Run your own keeper if you like; the built-in one runs on the backend.' },
  { q: 'What does the Agent need from me?', a: 'One permission, with limits you choose. After that it still reads every command back, and your wallet still asks you to approve each transaction. It never sees your keys.' },
  { q: 'Which tokens can I trade?', a: 'On Arc mainnet, every token the aggregator can route that is whitelisted and not flagged as a honeypot or fee-on-transfer. Being listed is not an endorsement. Orders and DCA need a price feed for the token on the contract.' },
  { q: 'Is the contract audited?', a: 'Not yet. It has an extensive test suite and a live test campaign on Arc Testnet, but treat it as unaudited software and size your risk accordingly.' },
  { q: 'Can I try it without real money?', a: 'Yes. Switch to Testnet: test tokens, a test price feed you can move, and a test router let you try every order type.' },
] as const

function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section className="mx-auto mb-24 max-w-3xl">
      <SectionTitle eyebrow="FAQ" title="Questions, answered plainly" />
      <div className="space-y-3">
        {FAQ.map((f, i) => (
          <Reveal key={f.q}>
            <div className="glass overflow-hidden rounded-2xl">
              <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-medium sm:text-base">
                {f.q}
                <ChevronDown className={clsx('h-4 w-4 shrink-0 text-mute transition-transform duration-300', open === i && 'rotate-180 text-accent')} />
              </button>
              <AnimatePresence initial={false}>
                {open === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
                    <p className="px-5 pb-5 text-sm text-mute">{f.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

// ---------- closing call ----------

function Closing({ onTrade }: { onTrade: () => void }) {
  return (
    <Reveal className="mx-auto mb-4 max-w-[1200px]">
      <div className="glass glow relative isolate overflow-hidden rounded-3xl px-6 py-14 text-center sm:py-20">
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <div className="anim-drift-a absolute left-1/4 top-0 h-72 w-72 rounded-full bg-accent/25 blur-[100px]" />
          <div className="anim-drift-b absolute bottom-0 right-1/4 h-72 w-72 rounded-full bg-accent2/20 blur-[100px]" />
        </div>
        <h2 className="mx-auto max-w-2xl font-display text-3xl font-semibold tracking-tight sm:text-5xl">
          Start on <span className="gradient-text">Arc</span> in under a minute
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-sm text-mute sm:text-base">Connect a wallet, try it with test tokens, then move to mainnet when you are ready.</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <PrimaryButton onClick={onTrade}>Launch app</PrimaryButton>
          <GhostButton href={BRAND.links.docs}>
            <BookOpen className="h-4 w-4" /> Read the docs
          </GhostButton>
        </div>
      </div>
    </Reveal>
  )
}

export function Landing() {
  const { setPage } = useSettings()
  return (
    <div className="-mt-4">
      <Hero onTrade={() => setPage('trade')} onAgent={() => setPage('agent')} />
      <TokenMarquee />
      <Features />
      <HowItWorks />
      <AgentSection onAgent={() => setPage('agent')} />
      <Security />
      <Faq />
      <Closing onTrade={() => setPage('trade')} />
    </div>
  )
}
