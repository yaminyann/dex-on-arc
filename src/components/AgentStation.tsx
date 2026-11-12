import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Loader2, Send, Sparkles, ShieldCheck } from 'lucide-react'
import { clsx } from 'clsx'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { BRAND } from '@/brand'
import type { NetworkConfig } from '@/trading/networks'
import { useTokenList } from '@/trading/tokens'
import { useNowSeconds } from '@/trading/hooks'
import { useSettings } from '@/trading/settings'
import { parseOnchainError } from '@/trading/tx'
import { parseCommand, type Intent } from '@/trading/agent/parser'
import { useAgentEngine, type Answer, type Plan, type RunResult } from '@/trading/agent/engine'
import {
  addSpent,
  DEFAULT_AGENT,
  DURATIONS,
  gateCommand,
  isGrantActive,
  loadSpentToday,
  SCOPE_LABEL,
  type AgentMode,
  type AgentPermission,
  type AgentScope,
} from '@/trading/agent-permission'
import { Badge, Button, Field, Notice, Panel, Segmented, Switch } from './ui'

type ConfirmState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'agent'; kind: 'text'; text: string; lines?: [string, string][]; tone?: 'error' }
  | { id: number; role: 'agent'; kind: 'confirm'; intent: Intent; plan: Plan; state: ConfirmState; auto: boolean; progress?: string; result?: RunResult; error?: string; note?: string }
  | { id: number; role: 'agent'; kind: 'grant'; pending: string | null; open: boolean }

/** A message before it gets its id. Distributes over the union so each variant keeps its own fields. */
type NewMsg = Msg extends infer M ? (M extends { id: number } ? Omit<M, 'id'> : never) : never

const YES = /^(y|yes|yep|yeah|confirm|confirmed|ok|okay|do it|go|go ahead|haan|ha)$/i
const NO = /^(n|no|nope|cancel|stop|abort|na|nah)$/i
const STALE_MS = 60_000

/** One-time permission form. It never touches keys: the wallet still signs every transaction. */
function GrantForm({ initial, onGrant, compact }: { initial: AgentPermission; onGrant: (p: AgentPermission) => void; compact?: boolean }) {
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]['id']>('24h')
  const [mode, setMode] = useState<AgentMode>(initial.mode)
  const [maxCmd, setMaxCmd] = useState(String(initial.maxPerCommand))
  const [daily, setDaily] = useState(String(initial.dailyLimit))
  const [scopes, setScopes] = useState(initial.scopes)
  const maxN = Number(maxCmd)
  const dayN = Number(daily)
  const valid = Number.isFinite(maxN) && maxN > 0 && Number.isFinite(dayN) && dayN >= maxN

  const grant = () => {
    const d = DURATIONS.find((x) => x.id === duration)!
    const now = Date.now()
    // "This tab only" is kept as a short grant that the page also drops when it closes.
    const expiresAt = d.ms === 0 ? null : d.ms === -1 ? now + 12 * 3_600_000 : now + d.ms
    onGrant({ granted: true, grantedAt: now, expiresAt, mode, maxPerCommand: maxN, dailyLimit: dayN, scopes })
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs text-mute">How long</div>
        <div className="flex flex-wrap gap-1.5">
          {DURATIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDuration(d.id)}
              aria-pressed={duration === d.id}
              className={clsx('min-h-[30px] rounded-md border px-2.5 text-xs', duration === d.id ? 'border-accent text-accent' : 'border-line text-mute hover:text-ink')}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-mute">Before each command runs</div>
        <Segmented
          className="w-full"
          value={mode}
          onChange={setMode}
          options={[
            { id: 'confirm', label: 'Ask "is this exact?"' },
            { id: 'auto', label: 'Run inside limits' },
          ]}
        />
        <p className="mt-1 text-[11px] text-mute">
          {mode === 'confirm' ? 'The agent reads every command back and waits for your yes.' : 'Commands inside the limits run right after the readback. Anything bigger or unpriced still waits for your yes.'}
        </p>
      </div>

      <div className={clsx('grid gap-2', compact ? 'grid-cols-1' : 'grid-cols-2')}>
        <Field label="Max per command" value={maxCmd} onChange={(e) => setMaxCmd(e.target.value)} right="USDC" error={maxCmd !== '' && !(maxN > 0) ? 'Above 0' : null} />
        <Field label="Max per day" value={daily} onChange={(e) => setDaily(e.target.value)} right="USDC" error={daily !== '' && !(dayN >= maxN) ? 'At least the per-command limit' : null} />
      </div>

      <div>
        <div className="mb-1 text-xs text-mute">What it may do</div>
        {(Object.keys(SCOPE_LABEL) as AgentScope[]).map((k) => (
          <Switch key={k} checked={scopes[k]} onChange={(v) => setScopes({ ...scopes, [k]: v })} label={SCOPE_LABEL[k]} />
        ))}
      </div>

      <Button variant="primary" className="w-full" disabled={!valid} onClick={grant}>
        Allow the agent
      </Button>
      <p className="text-[11px] text-mute">Your wallet still asks you to approve every transaction. You can change or revoke this at any time.</p>
    </div>
  )
}

function Bubble({ children, mine }: { children: React.ReactNode; mine?: boolean }) {
  return (
    <div className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={clsx('max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm sm:max-w-[80%]', mine ? 'bg-accent text-accent-ink' : 'border border-line bg-raised')}>{children}</div>
    </div>
  )
}

function Lines({ lines }: { lines: [string, string][] }) {
  return (
    <div className="mt-2 divide-y divide-line rounded-lg border border-line bg-panel/60 px-3">
      {lines.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="flex items-baseline justify-between gap-4 py-1.5 text-xs">
          <span className="text-mute">{k}</span>
          <span className="num text-right">{v}</span>
        </div>
      ))}
    </div>
  )
}

export function AgentStation({ network }: { network: NetworkConfig }) {
  const s = useSettings()
  const engine = useAgentEngine(network)
  const tokens = useTokenList(network).tokens
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [spent, setSpent] = useState(() => loadSpentToday())
  const nextId = useRef(1)
  const scroller = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<Msg[]>([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const sample = tokens[0]?.symbol ?? 'tBTC'
  const chips = useMemo(() => [`buy 10 USDC of ${sample}`, `sell 50% of ${sample}`, `stop loss 0.001 ${sample} at 80000`, `dca 1 USDC into ${sample} daily for 7 days`, 'orders', 'help'], [sample])
  const nowMs = useNowSeconds(10_000) * 1000
  const active = isGrantActive(s.agent, nowMs)

  const push = useCallback((m: NewMsg) => {
    const id = nextId.current++
    setMessages((prev) => [...prev.slice(-99), { ...m, id }])
    return id
  }, [])
  const patch = useCallback((id: number, change: Partial<Extract<Msg, { kind: 'confirm' }>>) => {
    setMessages((prev) => prev.map((m) => (m.id === id && m.role === 'agent' && m.kind === 'confirm' ? { ...m, ...change } : m)))
  }, [])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking])

  const say = useCallback((text: string, extra: { lines?: [string, string][]; tone?: 'error' } = {}) => push({ role: 'agent', kind: 'text', text, ...extra }), [push])

  const run = useCallback(
    async (id: number, plan: Plan) => {
      patch(id, { state: 'running', progress: 'Starting…' })
      try {
        const result = await plan.run((progress) => patch(id, { progress }))
        if (plan.valueUsdc) setSpent(addSpent(plan.valueUsdc))
        patch(id, { state: 'done', result, progress: undefined })
      } catch (e) {
        const msg = e instanceof Error && e.message && !/^(Something|The transaction)/.test(parseOnchainError(e)) ? parseOnchainError(e) : e instanceof Error ? e.message : 'Something went wrong.'
        patch(id, { state: 'failed', error: msg, progress: undefined })
      }
    },
    [patch],
  )

  const startAction = useCallback(
    async (text: string, intent: Intent, skipGrantCheck = false) => {
      if (!engine.connected) {
        say('Connect your wallet first, then send the command again.', { tone: 'error' })
        return
      }
      if (!skipGrantCheck && !isGrantActive(s.agent, Date.now())) {
        push({ role: 'agent', kind: 'grant', pending: text, open: true })
        return
      }
      setThinking(true)
      try {
        const built = await engine.buildPlan(intent)
        if (!built.ok) {
          say(built.error, { tone: 'error' })
          return
        }
        const plan = built.plan
        const gate = gateCommand(s.agent, plan.scope, plan.valueUsdc, loadSpentToday(), Date.now())
        if (!gate.allowed) {
          say(`${gate.reason} Change the limits in the permission panel if you want to allow it.`, { tone: 'error' })
          return
        }
        const id = push({ role: 'agent', kind: 'confirm', intent, plan, state: 'waiting', auto: gate.autoRun })
        if (gate.autoRun) {
          setThinking(false)
          await run(id, plan)
        }
      } finally {
        setThinking(false)
      }
    },
    [engine, s.agent, say, push, run],
  )

  const confirmLatest = useCallback(async () => {
    const waiting = [...messagesRef.current].reverse().find((m) => m.role === 'agent' && m.kind === 'confirm' && m.state === 'waiting') as Extract<Msg, { kind: 'confirm' }> | undefined
    if (!waiting) {
      say('There is nothing waiting for a yes. Send a command first.')
      return
    }
    if (!isGrantActive(s.agent, Date.now())) {
      patch(waiting.id, { state: 'cancelled' })
      push({ role: 'agent', kind: 'grant', pending: null, open: true })
      return
    }
    // A quote older than a minute may no longer be what the user read. Rebuild and ask again.
    if (Date.now() - waiting.plan.builtAt > STALE_MS) {
      patch(waiting.id, { state: 'cancelled', note: 'Expired' })
      setThinking(true)
      try {
        const built = await engine.buildPlan(waiting.intent)
        if (!built.ok) return void say(built.error, { tone: 'error' })
        push({ role: 'agent', kind: 'confirm', intent: waiting.intent, plan: built.plan, state: 'waiting', auto: false, note: 'Prices may have moved while you were reading, so here is the fresh version. Confirm again if it is still right.' })
      } finally {
        setThinking(false)
      }
      return
    }
    await run(waiting.id, waiting.plan)
  }, [engine, s.agent, say, push, patch, run])

  const cancelLatest = useCallback(() => {
    const waiting = [...messagesRef.current].reverse().find((m) => m.role === 'agent' && m.kind === 'confirm' && m.state === 'waiting')
    if (!waiting) return void say('There is nothing to cancel.')
    patch(waiting.id, { state: 'cancelled' })
    say('Cancelled. Nothing was sent.')
  }, [say, patch])

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || thinking) return
      setInput('')
      push({ role: 'user', text })
      if (YES.test(text)) return void (await confirmLatest())
      if (NO.test(text)) return cancelLatest()

      const parsed = parseCommand(text)
      if (!parsed.ok) {
        say(parsed.error + (parsed.example ? `\nExample: ${parsed.example}` : ''), { tone: 'error' })
        return
      }
      const intent = parsed.intent
      if (intent.kind === 'help' || intent.kind === 'balance' || intent.kind === 'orders' || intent.kind === 'price') {
        setThinking(true)
        try {
          const a: Answer = await engine.answer(intent)
          say(a.text ?? '', { lines: a.lines.length ? a.lines : undefined })
        } finally {
          setThinking(false)
        }
        return
      }
      // A new action replaces any readback still waiting, so a stray "yes" can only confirm the latest command.
      for (const m of messagesRef.current) if (m.role === 'agent' && m.kind === 'confirm' && m.state === 'waiting') patch(m.id, { state: 'cancelled', note: 'Replaced by a newer command' })
      await startAction(text, intent)
    },
    [thinking, push, confirmLatest, cancelLatest, say, engine, patch, startAction],
  )

  const onGrant = (p: AgentPermission, pending: string | null, grantMsgId?: number) => {
    s.setAgent(p)
    if (grantMsgId !== undefined) setMessages((prev) => prev.map((m) => (m.id === grantMsgId && m.role === 'agent' && m.kind === 'grant' ? { ...m, open: false } : m)))
    say(`Permission granted${p.expiresAt ? ` until ${new Date(p.expiresAt).toLocaleString()}` : ' until you revoke it'}. Limits: ${p.maxPerCommand} USDC per command, ${p.dailyLimit} USDC per day.`)
    if (pending) {
      // Carry on with the command that asked for permission, using the grant that was just made.
      const parsed = parseCommand(pending)
      if (parsed.ok) void startActionWith(p, pending, parsed.intent)
    }
  }

  // After a grant, `s.agent` has not re-rendered yet; run the first command with the fresh permission.
  const startActionWith = async (p: AgentPermission, text: string, intent: Intent) => {
    if (!engine.connected) return say('Connect your wallet first, then send the command again.', { tone: 'error' })
    setThinking(true)
    try {
      const built = await engine.buildPlan(intent)
      if (!built.ok) return void say(built.error, { tone: 'error' })
      const gate = gateCommand(p, built.plan.scope, built.plan.valueUsdc, loadSpentToday(), Date.now())
      if (!gate.allowed) return void say(gate.reason, { tone: 'error' })
      const id = push({ role: 'agent', kind: 'confirm', intent, plan: built.plan, state: 'waiting', auto: gate.autoRun })
      if (gate.autoRun) {
        setThinking(false)
        await run(id, built.plan)
      }
    } finally {
      setThinking(false)
    }
    void text
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Panel className="flex min-h-[520px] flex-col lg:h-[calc(100dvh-190px)]">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15 text-accent">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h1 className="font-display text-sm font-semibold">Agent Station</h1>
            <p className="text-[11px] text-mute">Type a command. {BRAND.name} reads it back, you confirm, then it runs.</p>
          </div>
          <Badge tone={active ? 'up' : 'warn'}>{active ? 'Permission on' : 'Permission off'}</Badge>
        </div>

        <div ref={scroller} className="thin-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="mx-auto max-w-md space-y-3 py-6 text-center">
              <h2 className="font-display text-lg font-semibold">What do you want to do?</h2>
              <p className="text-sm text-mute">Buy, sell, set a stop-loss or take-profit, start a DCA, or manage your orders in plain words. Nothing is sent until you say yes.</p>
              <Notice>
                This is a command interpreter, not a chat model: it understands a fixed set of commands and tells you when it does not. Type <b>help</b> to see them.
              </Notice>
            </div>
          )}

          {messages.map((m) => {
            if (m.role === 'user') {
              return (
                <Bubble key={m.id} mine>
                  {m.text}
                </Bubble>
              )
            }
            if (m.kind === 'text') {
              return (
                <Bubble key={m.id}>
                  {m.text && <div className={clsx('whitespace-pre-wrap', m.tone === 'error' && 'text-down')}>{m.text}</div>}
                  {m.lines && <Lines lines={m.lines} />}
                </Bubble>
              )
            }
            if (m.kind === 'grant') {
              return (
                <Bubble key={m.id}>
                  <div className="flex items-center gap-2 font-medium">
                    <ShieldCheck className="h-4 w-4 text-accent" /> Allow the agent to act for you?
                  </div>
                  <p className="mt-1 text-xs text-mute">You do this once. After that, commands inside your limits do not ask for permission again.</p>
                  {m.open ? (
                    <div className="mt-3">
                      <GrantForm initial={s.agent.granted ? s.agent : DEFAULT_AGENT} onGrant={(p) => onGrant(p, m.pending, m.id)} compact />
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-up">Granted.</p>
                  )}
                </Bubble>
              )
            }
            const cardTone = m.state === 'done' ? 'border-up/50' : m.state === 'failed' ? 'border-down/50' : m.state === 'waiting' ? 'border-accent/60' : 'border-line'
            return (
              <Bubble key={m.id}>
                {m.note && <p className="mb-2 text-xs text-warn">{m.note}</p>}
                <div className="font-medium">{m.state === 'waiting' ? 'Is this exactly what you want?' : m.plan.title}</div>
                <div className={clsx('mt-2 rounded-lg border p-1', cardTone)}>
                  <Lines lines={m.plan.lines} />
                </div>
                {m.plan.warnings.length > 0 && m.state === 'waiting' && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-mute">
                    {m.plan.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                {m.state === 'waiting' && (
                  <div className="mt-3 flex gap-2">
                    <Button variant="primary" className="flex-1" onClick={() => void confirmLatest()}>
                      Yes, run it
                    </Button>
                    <Button variant="ghost" className="flex-1" onClick={cancelLatest}>
                      Cancel
                    </Button>
                  </div>
                )}
                {m.state === 'running' && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-mute">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> {m.auto ? 'Running inside your limits. ' : ''}
                    {m.progress}
                  </div>
                )}
                {m.state === 'done' && m.result && (
                  <div className="mt-3 space-y-1 text-xs">
                    <div className="text-up">{m.result.summary}</div>
                    {m.result.hashes.map((h) => (
                      <a key={h} href={buildTxExplorerUrl(network.chainId, h)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-mute hover:text-accent">
                        {h.slice(0, 10)}…{h.slice(-6)} <ExternalLink className="h-3 w-3" />
                      </a>
                    ))}
                  </div>
                )}
                {m.state === 'failed' && <div className="mt-3 text-xs text-down">Nothing was completed: {m.error}</div>}
                {m.state === 'cancelled' && <div className="mt-3 text-xs text-mute">{m.note ?? 'Cancelled. Nothing was sent.'}</div>}
              </Bubble>
            )
          })}

          {thinking && (
            <Bubble>
              <span className="flex items-center gap-2 text-mute">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking prices and your balances…
              </span>
            </Bubble>
          )}
        </div>

        <div className="border-t border-line p-3">
          <div className="thin-scroll mb-2 flex gap-1.5 overflow-x-auto">
            {chips.map((c) => (
              <button key={c} onClick={() => setInput(c)} className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-mute hover:border-accent/50 hover:text-ink">
                {c}
              </button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void submit(input)
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Try: buy 10 USDC of tBTC   ·   or "yes" to confirm'
              aria-label="Command"
              autoComplete="off"
              className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-sm outline-none placeholder:text-mute/60 focus:border-accent"
            />
            <Button type="submit" variant="primary" disabled={!input.trim() || thinking} aria-label="Send">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </Panel>

      <aside className="min-w-0 space-y-4">
        <PermissionPanel spent={spent} onReset={() => setSpent(0)} />
        <Panel className="p-4">
          <h3 className="font-display text-sm font-semibold">How it stays safe</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs text-mute">
            <li>Your wallet signs every transaction. The agent never holds keys.</li>
            <li>Every action is read back with exact amounts, prices and fees before it runs.</li>
            <li>Limits per command and per day, and a switch for each kind of action.</li>
            <li>Prices older than a minute are refreshed and asked about again.</li>
            <li>It uses your slippage and expiry settings, and the same checks as the forms.</li>
          </ul>
        </Panel>
      </aside>
    </div>
  )
}

function PermissionPanel({ spent, onReset }: { spent: number; onReset: () => void }) {
  const s = useSettings()
  const p = s.agent
  const active = isGrantActive(p, useNowSeconds(10_000) * 1000)
  const [editing, setEditing] = useState(false)

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold">Permission</h3>
        <Badge tone={active ? 'up' : p.granted ? 'down' : 'mute'}>{active ? 'Granted' : p.granted ? 'Expired' : 'Not granted'}</Badge>
      </div>

      {active && !editing ? (
        <>
          <div className="divide-y divide-line rounded-lg border border-line px-3 text-xs">
            <PermLine k="Until" v={p.expiresAt ? new Date(p.expiresAt).toLocaleString() : 'You revoke it'} />
            <PermLine k="Before running" v={p.mode === 'auto' ? 'Run inside limits' : 'Ask "is this exact?"'} />
            <PermLine k="Per command" v={`${p.maxPerCommand} USDC`} />
            <PermLine k="Per day" v={`${p.dailyLimit} USDC`} />
            <PermLine k="Used today" v={`${spent.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`} />
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, p.dailyLimit > 0 ? (spent / p.dailyLimit) * 100 : 0)}%` }} />
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => setEditing(true)}>
              Change
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => s.setAgent({ ...p, granted: false })}>
              Revoke
            </Button>
          </div>
          <button
            className="mt-2 text-[11px] text-mute hover:text-ink"
            onClick={() => {
              clearUsageAndNotify()
              onReset()
            }}
          >
            Reset today's usage
          </button>
        </>
      ) : (
        <>
          <p className="mb-3 text-xs text-mute">Grant it once and it keeps working inside the limits you set, until it expires or you revoke it.</p>
          <GrantForm
            initial={p.granted ? p : DEFAULT_AGENT}
            compact
            onGrant={(next) => {
              s.setAgent(next)
              setEditing(false)
            }}
          />
        </>
      )}
    </Panel>
  )
}

function clearUsageAndNotify() {
  localStorage.removeItem('arcora-agent-usage-v1')
}

function PermLine({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-mute">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  )
}
