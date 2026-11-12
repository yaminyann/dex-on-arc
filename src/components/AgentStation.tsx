import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { formatUnits } from 'viem'
import { clsx } from 'clsx'
import { buildTxExplorerUrl } from '@/onchain-facts'
import type { NetworkConfig } from '@/trading/networks'
import { useTokenList } from '@/trading/tokens'
import { useBackendHealth, useNowSeconds } from '@/trading/hooks'
import { useAccountSummary } from '@/trading/account'
import { DcaStatus, OrderType, Side, Status } from '@/trading/types'
import { useSettings } from '@/trading/settings'
import { parseOnchainError } from '@/trading/tx'
import { parseCommand, type Intent } from '@/trading/agent/parser'
import { takeAgentPrefill } from '@/trading/agent/prefill'
import { canonicalizeIntent, interpretChat, type ChatContext, type Suggestion } from '@/trading/agent/chat'
import { askAgentModel } from '@/trading/agent/llm'
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
  | { id: number; role: 'agent'; kind: 'text'; text: string; lines?: [string, string][]; tone?: 'error'; suggestions?: Suggestion[] }
  | { id: number; role: 'agent'; kind: 'confirm'; intent: Intent; plan: Plan; state: ConfirmState; auto: boolean; progress?: string; result?: RunResult; error?: string; note?: string }
  | { id: number; role: 'agent'; kind: 'grant'; pending: string | null; open: boolean }

/** A message before it gets its id. Distributes over the union so each variant keeps its own fields. */
type NewMsg = Msg extends infer M ? (M extends { id: number } ? Omit<M, 'id'> : never) : never

const YES = /^(y|yes|yep|yeah|confirm|confirmed|ok|okay|do it|go|go ahead|haan|ha)$/i
const NO = /^(n|no|nope|cancel|stop|abort|na|nah)$/i
const STALE_MS = 60_000

/** One-time permission form. It never touches keys: the wallet still signs every transaction. */
function GrantForm({ initial, onGrant }: { initial: AgentPermission; onGrant: (p: AgentPermission) => void }) {
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
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-xs font-bold">How long</div>
        <div className="flex flex-wrap gap-2">
          {DURATIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDuration(d.id)}
              aria-pressed={duration === d.id}
              className={clsx('press min-h-[44px] border border-line px-3 text-xs font-bold shadow-hard-sm', duration === d.id ? 'bg-accent text-accent-ink' : 'bg-panel hover:bg-raised')}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-xs font-bold">Before each command runs</div>
        <Segmented className="w-full" value={mode} onChange={setMode} options={[{ id: 'confirm', label: 'Ask "is this exact?"' }, { id: 'auto', label: 'Run inside limits' }]} />
        <p className="mt-1.5 text-xs text-mute">{mode === 'confirm' ? 'The agent reads every command back and waits for your yes.' : 'Commands inside the limits run right after the readback. Anything bigger, or anything it cannot price, still waits for your yes.'}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Largest command" value={maxCmd} onChange={(e) => setMaxCmd(e.target.value)} right="USDC" error={maxCmd !== '' && !(maxN > 0) ? 'Above 0' : null} />
        <Field label="Largest per day" value={daily} onChange={(e) => setDaily(e.target.value)} right="USDC" error={daily !== '' && !(dayN >= maxN) ? 'At least the per-command limit' : null} />
      </div>

      <div>
        <div className="mb-1 text-xs font-bold">What it may do</div>
        <div className="divide-y divide-line/40 border border-line px-3">
          {(Object.keys(SCOPE_LABEL) as AgentScope[]).map((k) => (
            <Switch key={k} checked={scopes[k]} onChange={(v) => setScopes({ ...scopes, [k]: v })} label={SCOPE_LABEL[k]} />
          ))}
        </div>
      </div>

      <Button variant="primary" className="w-full" disabled={!valid} onClick={grant}>
        Allow the agent
      </Button>
      <p className="text-xs text-mute">Your wallet still asks you to approve every transaction. You can change or revoke this at any time.</p>
    </div>
  )
}

function Bubble({ children, mine }: { children: ReactNode; mine?: boolean }) {
  return (
    <div className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={clsx('max-w-[94%] border border-line px-3.5 py-2.5 text-sm sm:max-w-[82%]', mine ? 'bg-ink font-mono text-canvas' : 'bg-panel shadow-hard-sm')}>{children}</div>
    </div>
  )
}

function Lines({ lines }: { lines: [string, string][] }) {
  return (
    <div className="mt-2 border border-line bg-raised px-3">
      {lines.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="flex items-baseline justify-between gap-4 border-b border-line/40 py-1.5 text-xs last:border-b-0">
          <span className="text-mute">{k}</span>
          <span className="num text-right font-semibold">{v}</span>
        </div>
      ))}
    </div>
  )
}

const STATE_TAG: Record<ConfirmState, { label: string; tone: 'accent' | 'warn' | 'up' | 'down' | 'mute' }> = {
  waiting: { label: 'Waiting for your yes', tone: 'accent' },
  running: { label: 'Running', tone: 'warn' },
  done: { label: 'Done', tone: 'up' },
  failed: { label: 'Failed', tone: 'down' },
  cancelled: { label: 'Cancelled', tone: 'mute' },
}

type View = 'chat' | 'permission' | 'commands'

export function AgentStation({ network }: { network: NetworkConfig }) {
  const s = useSettings()
  const engine = useAgentEngine(network)
  const tokens = useTokenList(network).tokens
  const account = useAccountSummary(network)
  const health = useBackendHealth()
  const modelOn = health.data?.agentChat?.enabled === true
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState(() => takeAgentPrefill())
  const [thinking, setThinking] = useState(false)
  const [spent, setSpent] = useState(() => loadSpentToday())
  const [view, setView] = useState<View>('chat')
  const nextId = useRef(1)
  const scroller = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const messagesRef = useRef<Msg[]>([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const sample = tokens[0]?.symbol ?? 'tBTC'
  const nowMs = useNowSeconds(10_000) * 1000
  const active = isGrantActive(s.agent, nowMs)

  // What the chat layer may look at: symbols, oracle prices and what the wallet holds. It never leaves the browser
  // unless the operator's optional model is on, and then only the typed message and the symbol list are sent.
  const chatCtx = useMemo<ChatContext>(() => {
    const q = network.quote
    const symbolOf = new Map(account.rows.map((r) => [r.token.address.toLowerCase(), r.token.symbol]))
    const prices: Record<string, number> = {}
    for (const b of network.bases) {
      const o = account.prices[b.address.toLowerCase()]
      if (o?.status === 'ok') prices[b.symbol] = Number(formatUnits(o.price18, 18))
    }
    const holdings = account.rows
      .filter((r) => r.token.address !== q.address && r.available + r.locked > 0n)
      .map((r) => ({ symbol: r.token.symbol, amount: Number(formatUnits(r.available + r.locked, r.token.decimals)), price: prices[r.token.symbol] ?? null }))
    const stopTypes: number[] = [OrderType.STOP_LOSS, OrderType.STOP_LIMIT, OrderType.TRAILING_STOP, OrderType.OCO]
    const protectedSymbols = account.orders
      .filter((o) => o.status === Status.OPEN && o.side === Side.SELL && stopTypes.includes(o.orderType))
      .map((o) => symbolOf.get(o.base.toLowerCase()))
      .filter((x): x is string => Boolean(x))
    const quoteRow = account.rows.find((r) => r.token.address === q.address)
    return {
      tokens: tokens.map((t) => ({ symbol: t.symbol, name: t.name })),
      quote: q.symbol,
      connected: account.connected,
      holdings,
      prices,
      freeQuote: quoteRow ? Number(formatUnits(quoteRow.available, q.decimals)) : 0,
      protectedSymbols,
      activeDca: account.dcas.filter((d) => d.status === DcaStatus.ACTIVE).length,
    }
  }, [account, network, tokens])

  const COMMANDS = useMemo(
    () => [
      { group: 'Swap', items: [`buy 10 USDC of ${sample}`, `sell 50% of ${sample}`] },
      { group: 'Orders', items: [`limit buy ${sample} 5 USDC at 70000`, `stop loss 0.001 ${sample} at 80000`, `take profit 0.001 ${sample} at 100000`, `trailing stop 0.001 ${sample} 5%`, `oco 0.001 ${sample} sl 80000 tp 100000`] },
      { group: 'DCA', items: [`dca 1 USDC into ${sample} daily for 7 days`] },
      { group: 'Manage', items: ['cancel order 12', 'pause dca 3', 'resume dca 3', 'cancel dca 3'] },
      { group: 'Look up', items: [`price ${sample}`, 'balance', 'orders', 'help'] },
    ],
    [sample],
  )

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

  const say = useCallback((text: string, extra: { lines?: [string, string][]; tone?: 'error'; suggestions?: Suggestion[] } = {}) => push({ role: 'agent', kind: 'text', text, ...extra }), [push])

  const run = useCallback(
    async (id: number, plan: Plan) => {
      patch(id, { state: 'running', progress: 'Starting...' })
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

      // 1. The strict grammar. 2. Plain wording, read by fixed rules (free). 3. The operator's optional model.
      // Every route ends in the same place: one command of the grammar, a readback, and a wallet signature.
      let intent: Intent | null = null
      let source = text
      const strict = parseCommand(text)
      if (strict.ok) intent = canonicalizeIntent(strict.intent, chatCtx.tokens)
      else {
        const chat = interpretChat(text, chatCtx)
        if (chat.kind === 'reply') return void say(chat.text, { suggestions: chat.suggestions?.length ? chat.suggestions : undefined })
        if (chat.kind === 'command') {
          const p = parseCommand(chat.command)
          if (p.ok) {
            intent = p.intent
            source = chat.command
            say(chat.note)
          }
        }
        if (!intent && modelOn) {
          setThinking(true)
          try {
            const out = await askAgentModel(text, chatCtx.tokens.map((t) => t.symbol), chatCtx.quote)
            const p = out.command ? parseCommand(out.command) : null
            if (p?.ok && out.command) {
              intent = p.intent
              source = out.command
              say(`${out.reply ? out.reply + '\n' : ''}I read that as: ${out.command} (from the chat model, check the numbers below).`)
            } else {
              say(out.reply || `I could not turn that into an order. ${strict.error}`, { tone: out.reply ? undefined : 'error' })
              return
            }
          } catch (e) {
            say(`The chat model is not available right now (${e instanceof Error ? e.message : 'error'}). ${strict.error}`, { tone: 'error' })
            return
          } finally {
            setThinking(false)
          }
        }
        if (!intent) {
          say(strict.error + (strict.example ? `\nExample: ${strict.example}` : '') + '\nYou can also write it in your own words, or ask "what should I do?".', { tone: 'error' })
          return
        }
      }

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
      await startAction(source, intent)
    },
    [thinking, push, confirmLatest, cancelLatest, say, engine, patch, startAction, chatCtx, modelOn],
  )

  // After a grant, `s.agent` has not re-rendered yet; run the first command with the fresh permission.
  const startActionWith = async (p: AgentPermission, intent: Intent) => {
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
  }

  const onGrant = (p: AgentPermission, pending: string | null, grantMsgId?: number) => {
    s.setAgent(p)
    if (grantMsgId !== undefined) setMessages((prev) => prev.map((m) => (m.id === grantMsgId && m.role === 'agent' && m.kind === 'grant' ? { ...m, open: false } : m)))
    say(`Permission granted${p.expiresAt ? ` until ${new Date(p.expiresAt).toLocaleString()}` : ' until you revoke it'}. Limits: ${p.maxPerCommand} USDC per command, ${p.dailyLimit} USDC per day.`)
    if (pending) {
      // Carry on with the command that asked for permission, using the grant that was just made.
      const parsed = parseCommand(pending)
      if (parsed.ok) void startActionWith(p, parsed.intent)
    }
  }

  const insert = (command: string) => {
    setInput(command)
    setView('chat')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const chatHidden = view !== 'chat' ? 'hidden lg:flex' : 'flex'
  const sideHidden = (v: View) => (view !== v ? 'hidden lg:block' : 'block')

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl sm:text-5xl">Agent</h1>
          <p className="mt-1 max-w-xl text-sm text-mute">Chat in plain words or type a command. It is read back with the exact terms, you say yes, then it runs.</p>
        </div>
        <Badge tone={active ? 'up' : 'warn'}>{active ? 'Permission granted' : 'Permission not granted'}</Badge>
      </div>

      <div className="mb-3 lg:hidden">
        <Segmented className="w-full" value={view} onChange={setView} options={[{ id: 'chat', label: 'Chat' }, { id: 'permission', label: 'Permission' }, { id: 'commands', label: 'Commands' }]} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel raised className={clsx('min-w-0 flex-col', chatHidden, 'h-[calc(100dvh-23rem)] min-h-[340px] lg:h-[calc(100dvh-14rem)] lg:min-h-[420px]')}>
          <div ref={scroller} className="thin-scroll flex-1 space-y-3 overflow-y-auto p-3 sm:p-4" role="log" aria-live="polite" aria-label="Agent conversation">
            {messages.length === 0 && (
              <div className="mx-auto max-w-lg py-4 sm:py-8">
                <h2 className="text-2xl sm:text-3xl">What should it do?</h2>
                <p className="mt-2 text-sm text-mute">Chat in plain words: swap, set a stop-loss or take-profit, start a DCA, ask what an order does, or ask for ideas based on what you hold. Nothing is sent until you say yes and your wallet signs.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {['What should I do?', 'Protect my holdings', 'Explain DCA'].map((c) => (
                    <button key={c} onClick={() => void submit(c)} className="press min-h-[44px] border border-line bg-accent px-3 text-xs font-bold text-accent-ink shadow-hard-sm">
                      {c}
                    </button>
                  ))}
                </div>
                <p className="mb-2 mt-5 text-xs font-bold">Start from one of these</p>
                <ul className="space-y-2">
                  {COMMANDS.flatMap((g) => g.items.slice(0, 1)).slice(0, 4).map((c) => (
                    <li key={c}>
                      <button onClick={() => insert(c)} className="press num min-h-[44px] w-full border border-line bg-panel px-3 text-left text-sm shadow-hard-sm hover:bg-raised">
                        {c}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-5">
                  <Notice>
                    {modelOn
                      ? "Wording the built-in rules cannot read may be sent to the operator's language model. Only your message and the token symbols are sent, never balances or your address."
                      : 'Messages are read by fixed rules on your device. Nothing is sent anywhere and it costs nothing. Type help for the full list.'}{' '}
                    It can only produce a command from the fixed grammar, and every action is read back first.
                  </Notice>
                </div>
              </div>
            )}

            {messages.map((m) => {
              if (m.role === 'user') return <Bubble key={m.id} mine>{m.text}</Bubble>
              if (m.kind === 'text') {
                return (
                  <Bubble key={m.id}>
                    {m.text && <div className={clsx('whitespace-pre-wrap', m.tone === 'error' && 'font-semibold text-down')}>{m.text}</div>}
                    {m.lines && <Lines lines={m.lines} />}
                    {m.suggestions && (
                      <ul className="mt-3 space-y-2">
                        {m.suggestions.map((sg) => (
                          <li key={sg.label + sg.command}>
                            <button
                              onClick={() => (sg.mode === 'run' ? void submit(sg.command) : insert(sg.command))}
                              disabled={thinking}
                              className="press w-full border border-line bg-raised px-3 py-2 text-left shadow-hard-sm hover:bg-accent hover:text-accent-ink disabled:opacity-50"
                            >
                              <span className="block text-xs font-bold">{sg.label}</span>
                              <span className="num mt-0.5 block text-xs">{sg.command}</span>
                              <span className="mt-1 block text-xs text-mute">{sg.why}</span>
                              <span className="mt-1 block text-[11px] font-bold">{sg.mode === 'run' ? 'Tap to see the exact terms first' : 'Tap to put it in the box and edit'}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Bubble>
                )
              }
              if (m.kind === 'grant') {
                return (
                  <Bubble key={m.id}>
                    <div className="font-display text-base">Allow the agent to act for you?</div>
                    <p className="mt-1 text-xs text-mute">You do this once. After that, commands inside your limits do not ask for permission again.</p>
                    {m.open ? (
                      <div className="mt-3">
                        <GrantForm initial={s.agent.granted ? s.agent : DEFAULT_AGENT} onGrant={(p) => onGrant(p, m.pending, m.id)} />
                      </div>
                    ) : (
                      <p className="mt-2 text-xs font-bold text-up">Granted.</p>
                    )}
                  </Bubble>
                )
              }
              const tag = STATE_TAG[m.state]
              return (
                <Bubble key={m.id}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-display text-base">{m.state === 'waiting' ? 'Is this exactly what you want?' : m.plan.title}</span>
                    <Badge tone={tag.tone}>{tag.label}</Badge>
                  </div>
                  {m.note && <p className="mt-1 text-xs font-semibold text-warn">{m.note}</p>}
                  <Lines lines={m.plan.lines} />
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
                      <Button className="flex-1" onClick={cancelLatest}>
                        Cancel
                      </Button>
                    </div>
                  )}
                  {m.state === 'running' && (
                    <div className="mt-3 flex items-center gap-2 text-xs font-semibold">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> {m.auto ? 'Running inside your limits. ' : ''}
                      {m.progress}
                    </div>
                  )}
                  {m.state === 'done' && m.result && (
                    <div className="mt-3 space-y-1 text-xs">
                      <div className="font-semibold text-up">{m.result.summary}</div>
                      {m.result.hashes.map((h) => (
                        <a key={h} href={buildTxExplorerUrl(network.chainId, h)} target="_blank" rel="noopener noreferrer" className="num flex items-center gap-1 underline underline-offset-2">
                          {h.slice(0, 10)}...{h.slice(-6)} <ExternalLink className="h-3 w-3" />
                        </a>
                      ))}
                    </div>
                  )}
                  {m.state === 'failed' && <div className="mt-3 text-xs font-semibold text-down">Nothing was completed: {m.error}</div>}
                  {m.state === 'cancelled' && <div className="mt-3 text-xs text-mute">{m.note ?? 'Cancelled. Nothing was sent.'}</div>}
                </Bubble>
              )
            })}

            {thinking && (
              <Bubble>
                <span className="flex items-center gap-2 text-mute">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking prices and your balances...
                </span>
              </Bubble>
            )}
          </div>

          <form
            className="flex gap-2 border-t border-line bg-raised p-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submit(input)
            }}
          >
            <label className="sr-only" htmlFor="agent-command">
              Message or command
            </label>
            <input
              id="agent-command"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask anything, or: buy 10 USDC of ${sample}`}
              autoComplete="off"
              className="num min-h-[48px] min-w-0 flex-1 border border-line bg-panel px-3 text-sm placeholder:text-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
            <Button type="submit" variant="primary" className="min-h-[48px] px-5" disabled={!input.trim() || thinking}>
              Send
            </Button>
          </form>
        </Panel>

        <aside className="min-w-0 space-y-4">
          <div className={sideHidden('permission')}>
            <PermissionPanel spent={spent} onReset={() => setSpent(0)} />
          </div>
          <div className={sideHidden('commands')}>
            <Panel className="p-4">
              <h2 className="text-xl">Commands</h2>
              <p className="mb-3 mt-0.5 text-xs text-mute">Tap one to put it in the input. Change the numbers, then send.</p>
              <div className="space-y-4">
                {COMMANDS.map((g) => (
                  <div key={g.group}>
                    <h3 className="mb-1.5 text-sm">{g.group}</h3>
                    <ul className="space-y-1.5">
                      {g.items.map((c) => (
                        <li key={c}>
                          <button onClick={() => insert(c)} className="num min-h-[40px] w-full border border-line bg-panel px-2.5 text-left text-xs hover:bg-accent hover:text-accent-ink">
                            {c}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          <div className="hidden lg:block">
            <Panel className="p-4">
              <h2 className="text-xl">How it stays safe</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs text-mute">
                <li>Your wallet signs every transaction. The agent never holds keys.</li>
                <li>Every action is read back with exact amounts, prices and fees first.</li>
                <li>Limits per command and per day, and a switch for each kind of action.</li>
                <li>A plan older than a minute is rebuilt and asked about again.</li>
                <li>It uses your slippage and expiry settings and the same checks as the forms.</li>
              </ul>
            </Panel>
          </div>
        </aside>
      </div>
    </div>
  )
}

function PermissionPanel({ spent, onReset }: { spent: number; onReset: () => void }) {
  const s = useSettings()
  const p = s.agent
  const active = isGrantActive(p, useNowSeconds(10_000) * 1000)
  const [editing, setEditing] = useState(false)

  const row = (k: string, v: string) => (
    <div className="flex items-center justify-between gap-3 border-b border-line/40 py-2 text-xs last:border-b-0">
      <span className="text-mute">{k}</span>
      <span className="num text-right font-semibold">{v}</span>
    </div>
  )

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xl">Permission</h2>
        <Badge tone={active ? 'up' : p.granted ? 'down' : 'mute'}>{active ? 'Granted' : p.granted ? 'Expired' : 'Not granted'}</Badge>
      </div>

      {active && !editing ? (
        <>
          <div className="border border-line px-3">
            {row('Until', p.expiresAt ? new Date(p.expiresAt).toLocaleString() : 'You revoke it')}
            {row('Before running', p.mode === 'auto' ? 'Run inside limits' : 'Ask "is this exact?"')}
            {row('Largest command', `${p.maxPerCommand} USDC`)}
            {row('Largest per day', `${p.dailyLimit} USDC`)}
            {row('Used today', `${spent.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`)}
          </div>
          <div className="mt-2 h-3 border border-line bg-panel" role="img" aria-label={`${Math.round(p.dailyLimit > 0 ? Math.min(100, (spent / p.dailyLimit) * 100) : 0)} percent of today's limit used`}>
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, p.dailyLimit > 0 ? (spent / p.dailyLimit) * 100 : 0)}%` }} />
          </div>
          <div className="mt-3 flex gap-2">
            <Button className="flex-1" onClick={() => setEditing(true)}>
              Change
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => s.setAgent({ ...p, granted: false })}>
              Revoke
            </Button>
          </div>
          <button
            className="mt-2 min-h-[32px] text-xs font-semibold underline underline-offset-2"
            onClick={() => {
              localStorage.removeItem('lumarc-agent-usage-v1')
              onReset()
            }}
          >
            Reset today's usage
          </button>
        </>
      ) : (
        <>
          <p className="mb-3 text-xs text-mute">Grant it once. It keeps working inside the limits you set, until it expires or you revoke it.</p>
          <GrantForm
            initial={p.granted ? p : DEFAULT_AGENT}
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
