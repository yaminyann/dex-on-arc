import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { clsx } from 'clsx'
import { BRAND } from '@/brand'
import { fetchTokenList } from '@/trading/tokens'
import { useSettings } from '@/trading/settings'
import { setAgentPrefill } from '@/trading/agent/prefill'
import { Reveal } from './motion'
import { TokenBase } from './TokenIcon'
import { Skeleton } from './ui'

// ---------- shared pieces ----------

function Heading({ kicker, children }: { kicker: string; children: ReactNode }) {
  return (
    <div className="mb-8 max-w-3xl">
      <p className="mb-2 inline-block border border-line bg-accent px-2 py-0.5 font-mono text-xs font-semibold text-accent-ink">{kicker}</p>
      <h2 className="text-3xl leading-tight sm:text-5xl">{children}</h2>
    </div>
  )
}

function Cta({ children, onClick, variant = 'primary' }: { children: ReactNode; onClick: () => void; variant?: 'primary' | 'ghost' }) {
  return (
    <button onClick={onClick} className={clsx('press min-h-[52px] border border-line px-6 text-base font-bold shadow-hard', variant === 'primary' ? 'bg-accent text-accent-ink' : 'bg-panel hover:bg-raised')}>
      {children}
    </button>
  )
}

// ---------- the scripted agent session shown in the hero ----------

interface Script {
  id: string
  feature: string
  command: string
  lines: [string, string][]
  result: string
}

/** Amounts here are illustrative; the window is labelled as an example session. */
const SCRIPTS: Script[] = [
  { id: 'swap', feature: 'DEX swap', command: 'buy 10 USDC of tBTC', lines: [['Action', 'Market buy tBTC'], ['You spend', '10 USDC'], ['Route', 'Best of the quoted routes'], ['Max slippage', '0.50%']], result: 'Swap sent through the best quoted route. The router enforces your minimum output.' },
  { id: 'limit', feature: 'Limit order', command: 'limit buy tBTC 25 USDC at 70000', lines: [['Action', 'Limit buy tBTC'], ['Escrowed now', '25 USDC'], ['Buys at or below', '70,000 USDC'], ['Expires', '7 days']], result: 'Order created. A keeper fills it when the oracle price reaches your level.' },
  { id: 'sl', feature: 'Stop-loss', command: 'stop loss 0.5 tBTC at 80000', lines: [['Action', 'Stop-loss sell tBTC'], ['Escrowed now', '0.5 tBTC'], ['Sells when price falls to', '80,000 USDC'], ['Max slippage', '0.50%']], result: 'Order created. It runs when a keeper submits it, even with this tab closed.' },
  { id: 'tp', feature: 'Take-profit', command: 'take profit 0.5 tBTC at 100000', lines: [['Action', 'Take-profit sell tBTC'], ['Escrowed now', '0.5 tBTC'], ['Sells when price rises to', '100,000 USDC'], ['Expires', '7 days']], result: 'Order created. Cancel it any time to get the escrow back.' },
  { id: 'trail', feature: 'Trailing stop', command: 'trailing stop 0.5 tBTC 5%', lines: [['Action', 'Trailing stop sell tBTC'], ['Escrowed now', '0.5 tBTC'], ['Trails the peak by', '5%'], ['Needs', 'A keeper to record new highs']], result: 'Order created. The stop follows the highest price a keeper has recorded.' },
  { id: 'oco', feature: 'OCO', command: 'oco 0.5 tBTC sl 80000 tp 100000', lines: [['Action', 'OCO sell tBTC'], ['Escrowed now', '0.5 tBTC'], ['Stop-loss at', '80,000 USDC'], ['Take-profit at', '100,000 USDC']], result: 'One escrow, two exits. Whichever price is hit first runs and the other never can.' },
  { id: 'dca', feature: 'DCA', command: 'dca 5 USDC into tBTC daily for 30 days', lines: [['Action', 'Recurring buy of tBTC'], ['Per buy', '5 USDC'], ['Number of buys', '30'], ['Budget escrowed now', '150 USDC']], result: 'Plan created. Pause, resume, or cancel and take back what is left.' },
]

type Step = 'typing' | 'readback' | 'yes' | 'done'

function AgentDemo({ index, onIndex }: { index: number; onIndex: (i: number) => void }) {
  const { animate } = useSettings()
  const script = SCRIPTS[index]
  // The parent gives this component a new key per script, so each run starts from a clean state.
  const [typed, setTyped] = useState(animate ? 0 : script.command.length)
  const [step, setStep] = useState<Step>(animate ? 'typing' : 'done')
  const [paused, setPaused] = useState(false)
  const running = animate && !paused
  const advance = useRef(onIndex)
  useEffect(() => {
    advance.current = onIndex
  })

  // Types the command, then reads the plan back, says yes, and shows the result.
  useEffect(() => {
    if (!animate) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms))
    const typeEnd = 500 + script.command.length * 45
    for (let i = 1; i <= script.command.length; i++) at(500 + i * 45, () => setTyped(i))
    at(typeEnd + 400, () => setStep('readback'))
    at(typeEnd + 2300, () => setStep('yes'))
    at(typeEnd + 3000, () => setStep('done'))
    return () => timers.forEach(clearTimeout)
  }, [animate, script])

  // After the result has been on screen for a moment, move to the next example unless paused.
  useEffect(() => {
    if (step !== 'done' || !running) return
    const t = setTimeout(() => advance.current((index + 1) % SCRIPTS.length), 3200)
    return () => clearTimeout(t)
  }, [step, running, index])

  return (
    <div className="border border-line bg-panel shadow-hard-lg" role="group" aria-label="Example agent session">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-accent px-3 py-2 text-accent-ink">
        <span className="font-display text-base">Agent</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-semibold">Example session</span>
          {animate && (
            <button onClick={() => setPaused((p) => !p)} aria-pressed={paused} className="min-h-[32px] border border-line bg-panel px-2 font-mono text-[11px] font-semibold text-ink hover:bg-raised">
              {paused ? 'Play' : 'Pause'}
            </button>
          )}
        </span>
      </div>
      <div className="min-h-[380px] space-y-3 p-3 sm:p-4" aria-live="polite">
        <div className="flex justify-end">
          <div className="max-w-[90%] border border-line bg-ink px-3 py-2 font-mono text-sm text-canvas">
            {script.command.slice(0, typed)}
            {step === 'typing' && running && <span className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 bg-canvas" />}
          </div>
        </div>
        <AnimatePresence initial={false}>
          {step !== 'typing' && (
            <motion.div key={`${script.id}-card`} initial={animate ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="max-w-[96%] border border-line bg-raised p-3">
              <p className="text-sm font-bold">Is this exactly what you want?</p>
              <div className="mt-2 border border-line bg-panel px-3">
                {script.lines.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-line/40 py-1.5 text-xs last:border-b-0">
                    <span className="text-mute">{k}</span>
                    <span className="num text-right font-semibold">{v}</span>
                  </div>
                ))}
              </div>
              {step === 'readback' && (
                <div className="mt-3 flex gap-2 text-xs font-bold">
                  <span className="flex-1 border border-line bg-accent py-2 text-center text-accent-ink shadow-hard-sm">Yes, run it</span>
                  <span className="flex-1 border border-line bg-panel py-2 text-center">Cancel</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {(step === 'yes' || step === 'done') && (
          <div className="flex justify-end">
            <div className="border border-line bg-ink px-3 py-2 font-mono text-sm text-canvas">yes</div>
          </div>
        )}
        {step === 'done' && <p className="max-w-[96%] border border-line bg-up px-3 py-2 text-sm font-semibold text-canvas">{script.result}</p>}
      </div>
      <p className="border-t border-line px-3 py-2 text-[11px] text-mute">Amounts are illustrative. The real agent builds each plan from your balance, the oracle price and a live quote.</p>
    </div>
  )
}

// ---------- hero ----------

function Hero({ onTrade, onAgent }: { onTrade: () => void; onAgent: () => void }) {
  const [index, setIndex] = useState(0)
  const tokens = useQuery({ queryKey: ['landing-tokens'], queryFn: () => fetchTokenList(5042), staleTime: 10 * 60_000, retry: 1 })
  const count = tokens.data ? Math.max(0, tokens.data.length - 1) : null
  const facts: { value: string; label: string }[] = [
    { value: count === null ? (tokens.isError ? 'n/a' : '...') : String(count), label: 'tokens the aggregator can route on Arc' },
    { value: '6 + DCA', label: 'order types in one escrow contract' },
    { value: '0.10%', label: 'highest keeper fee, and it can only go down' },
    { value: 'No custody', label: 'orders sit in a contract you can always exit' },
  ]

  return (
    <section className="pb-10 pt-4 sm:pt-8">
      <div className="grid items-start gap-8 lg:grid-cols-[1.02fr_1fr] lg:gap-10">
        <div>
          <h1 className="text-[2.6rem] leading-[1.02] sm:text-6xl lg:text-[4.4rem]">
            Swaps, stops and DCA on Arc.
          </h1>
          <p className="mt-5 max-w-xl text-base sm:text-lg">
            Swap through the best aggregator route. Set limit, stop-loss, take-profit, trailing and OCO orders that keep running while your browser is closed. Schedule DCA buys. Or type the command and let the agent prepare it.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Cta onClick={onTrade}>Open the terminal</Cta>
            <Cta onClick={onAgent} variant="ghost">
              Try the agent
            </Cta>
          </div>

          <p className="mb-2 mt-9 text-sm font-bold">What the agent runs. Pick one to watch it.</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {SCRIPTS.map((s, i) => (
              <li key={s.id}>
                <button
                  onClick={() => setIndex(i)}
                  aria-pressed={index === i}
                  className={clsx('press min-h-[44px] w-full border border-line px-3 text-left text-sm font-bold shadow-hard-sm', index === i ? 'bg-accent text-accent-ink' : 'bg-panel hover:bg-raised')}
                >
                  {s.feature}
                </button>
              </li>
            ))}
            <li>
              <button onClick={onAgent} className="press min-h-[44px] w-full border border-line bg-ink px-3 text-left text-sm font-bold text-canvas shadow-hard-sm">
                Cancel, pause, resume
              </button>
            </li>
          </ul>
        </div>
        <AgentDemo key={index} index={index} onIndex={setIndex} />
      </div>

      <dl className="mt-10 grid border border-line bg-panel sm:grid-cols-2 lg:grid-cols-4">
        {facts.map((f, i) => (
          <div key={f.label} className={clsx('p-4', i > 0 && 'border-t border-line sm:border-t-0 sm:border-l', i === 2 && 'sm:border-t sm:border-l-0 lg:border-t-0 lg:border-l')}>
            <dt className="order-2 mt-1 text-xs text-mute">{f.label}</dt>
            <dd className="num font-display text-3xl leading-none sm:text-4xl">{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

// ---------- what it does: an index, not a card grid ----------

const FEATURES: { name: string; body: string; command: string }[] = [
  { name: 'Market swap', body: 'Quotes from every configured aggregator are ranked by guaranteed output after gas. A provider that fails is skipped for a while.', command: 'buy 10 USDC of tBTC' },
  { name: 'Limit order', body: 'Escrow USDC or the token. A keeper fills the order when the oracle price reaches your level.', command: 'limit buy tBTC 5 USDC at 70000' },
  { name: 'Stop-loss', body: 'Sells when the price falls to your stop. It follows the contract oracle, which can lag the market.', command: 'stop loss 0.001 tBTC at 80000' },
  { name: 'Take-profit', body: 'Sells when the price rises to your target. A triggered order is not guaranteed to fill.', command: 'take profit 0.001 tBTC at 100000' },
  { name: 'Trailing stop', body: 'The stop follows the highest price by a percentage you choose. A keeper has to record each new high.', command: 'trailing stop 0.001 tBTC 5%' },
  { name: 'OCO', body: 'One escrow, two exits. Whichever price is hit first runs, and the other can never run.', command: 'oco 0.001 tBTC sl 80000 tp 100000' },
  { name: 'DCA', body: 'Escrow a budget and buy a fixed amount every hour, day, week or month, with an optional price cap. Pause, resume, or cancel and take back the rest.', command: 'dca 1 USDC into tBTC daily for 7 days' },
]

function FeatureIndex({ onTry }: { onTry: (command: string) => void }) {
  return (
    <section className="py-10 sm:py-14">
      <Heading kicker="What it does">Seven ways to trade, one way to ask.</Heading>
      <ol className="border-t border-line">
        {FEATURES.map((f, i) => (
          <li key={f.name}>
            <Reveal>
              <div className="grid items-center gap-x-6 gap-y-2 border-b border-line py-5 sm:grid-cols-[64px_220px_minmax(0,1fr)_auto]">
                <span className="num font-display text-3xl">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="text-2xl">{f.name}</h3>
                <div>
                  <p className="text-sm text-mute">{f.body}</p>
                  <code className="num mt-2 inline-block border border-line bg-raised px-2 py-1 text-xs">{f.command}</code>
                </div>
                <button onClick={() => onTry(f.command)} className="press min-h-[44px] justify-self-start border border-line bg-panel px-4 text-sm font-bold shadow-hard-sm hover:bg-accent hover:text-accent-ink sm:justify-self-end">
                  Run it in the agent
                </button>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ---------- what happens after confirm ----------

const FLOW: [string, string][] = [
  ['You approve exactly the amount you are escrowing and sign the order in your wallet.', 'The contract takes that amount into escrow and records the order.'],
  ['You can close the browser.', 'A keeper watches the oracle price. The keeper is any wallet, not a server of ours.'],
  ['Nothing to do.', 'When the condition is met, the keeper calls execute. The contract swaps through an allowlisted router for the exact amount and rejects the fill if the output is below its own oracle-based floor.'],
  ['You can cancel any time.', 'Cancel, refund and expiry always work, even when the owner has paused the contract.'],
]

function Flow() {
  return (
    <section className="py-10 sm:py-14">
      <Heading kicker="After you press confirm">Who does what to your order.</Heading>
      <Reveal>
        <div className="border border-line bg-panel shadow-hard">
          <div className="grid grid-cols-2 border-b border-line bg-ink text-canvas">
            <p className="px-4 py-3 font-display text-lg">You</p>
            <p className="border-l border-canvas/40 px-4 py-3 font-display text-lg">Contract and keeper</p>
          </div>
          {FLOW.map(([you, chain], i) => (
            <div key={i} className="grid grid-cols-1 border-b border-line last:border-b-0 md:grid-cols-2">
              <p className="p-4 text-sm font-semibold">{you}</p>
              <p className="border-t border-line p-4 text-sm text-mute md:border-l md:border-t-0">{chain}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  )
}

// ---------- the agent band ----------

function AgentBand({ onAgent }: { onAgent: () => void }) {
  return (
    <section className="py-10 sm:py-14">
      <Reveal>
        <div className="grid gap-8 border border-line bg-accent p-5 text-accent-ink shadow-hard-lg sm:p-8 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <h2 className="text-3xl sm:text-5xl">Grant permission once. Read every command back.</h2>
            <ul className="mt-5 space-y-2 text-sm font-semibold">
              <li>The agent is a fixed command grammar, not a language model. The same words always mean the same action, and anything unclear is refused with an example.</li>
              <li>Each plan is built from your real balance, the oracle price and a live quote, then read back before it runs.</li>
              <li>Limits per command and per day, and a switch for each kind of action.</li>
              <li>Your wallet still asks you to approve every transaction. The agent never sees a key.</li>
            </ul>
            <div className="mt-6">
              <button onClick={onAgent} className="press min-h-[52px] border border-line bg-ink px-6 text-base font-bold text-canvas shadow-hard">
                Open the agent
              </button>
            </div>
          </div>
          <div className="border border-dashed border-line bg-panel p-4 text-ink">
            <p className="font-display text-lg">Permission</p>
            <p className="text-xs text-mute">Example limits. You choose your own.</p>
            <dl className="mt-3 divide-y divide-line/40 text-sm">
              {[['Lasts', '24 hours'], ['Largest command', '100 USDC'], ['Per day', '500 USDC'], ['Before running', 'Ask "is this exact?"'], ['Allowed', 'Swaps, orders, DCA, cancel and pause']].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 py-2">
                  <dt className="text-mute">{k}</dt>
                  <dd className="num text-right font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Reveal>
    </section>
  )
}

// ---------- tokens ----------

function Tokens() {
  const q = useQuery({ queryKey: ['landing-tokens'], queryFn: () => fetchTokenList(5042), staleTime: 10 * 60_000, retry: 1 })
  const list = (q.data ?? []).filter((t) => t.symbol !== 'USDC')
  return (
    <section className="py-10 sm:py-14">
      <Heading kicker="Tokens">Swap any token the aggregator can route.</Heading>
      <p className="-mt-4 mb-6 max-w-2xl text-sm text-mute">
        The list comes from KyberSwap's registry for Arc, filtered to whitelisted tokens that are not flagged as honeypots or fee-on-transfer. A listing is not an endorsement. Orders and DCA also need a price feed for the token on the contract.
      </p>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.isError ? (
        <p className="border border-line bg-raised p-4 text-sm">The token list could not be loaded right now. The backend may be offline. Open the terminal to retry.</p>
      ) : list.length === 0 ? (
        <p className="border border-line bg-raised p-4 text-sm">The registry returned no tokens for Arc.</p>
      ) : (
        <Reveal>
          <ul className="flex flex-wrap gap-2">
            {list.slice(0, 48).map((t) => (
              <li key={t.address} className="flex items-center gap-2 border border-line bg-panel py-1.5 pl-1.5 pr-3 text-sm font-semibold">
                <TokenBase token={{ symbol: t.symbol, logoURI: t.logoURI }} size={22} />
                {t.symbol}
              </li>
            ))}
            {list.length > 48 && <li className="flex items-center border border-line bg-raised px-3 text-sm font-semibold">+{list.length - 48} more</li>}
          </ul>
        </Reveal>
      )}
    </section>
  )
}

// ---------- owner powers ----------

const CAN = ['Pause new orders and executions', 'Lower the keeper fee', 'Set a minimum order size', 'Queue a new token feed or router, public and delayed', 'Disable a token or router at once']
const CANNOT = ['Take or freeze escrow, or block a refund', 'Raise the keeper fee', 'Add a token or router without the public delay', 'Upgrade or replace the contract code', 'Renounce ownership by accident']

function OwnerPowers() {
  return (
    <section className="py-10 sm:py-14">
      <Heading kicker="Trust">What the owner can and cannot do.</Heading>
      <Reveal>
        <div className="grid border border-line bg-panel md:grid-cols-2">
          <div className="p-5">
            <h3 className="text-xl">Can</h3>
            <ul className="mt-3 space-y-2 text-sm">
              {CAN.map((x) => (
                <li key={x} className="flex gap-2">
                  <span className="mt-1.5 h-2 w-2 shrink-0 bg-ink" aria-hidden="true" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-line bg-raised p-5 md:border-l md:border-t-0">
            <h3 className="text-xl">Cannot</h3>
            <ul className="mt-3 space-y-2 text-sm">
              {CANNOT.map((x) => (
                <li key={x} className="flex gap-2">
                  <span className="mt-1.5 h-2 w-2 shrink-0 border border-line" aria-hidden="true" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Reveal>
      <p className="mt-3 max-w-3xl text-sm text-mute">The contract is unaudited. These limits are enforced in code and covered by tests, but treat the software as unaudited and size your risk accordingly. Every owner action is a public transaction.</p>
    </section>
  )
}

// ---------- faq ----------

const FAQ = [
  { q: 'Do you hold my funds?', a: 'No. Swaps go from your wallet through an aggregator router. Orders and DCA plans are escrowed in a smart contract that only you can cancel and that pays out only by its own rules. There is no deposit to us.' },
  { q: 'Who executes my orders?', a: 'Any keeper. Execution is open to everyone and pays a keeper fee of at most 0.10% of the output. The built-in keeper runs on this site\'s backend, and you can run your own.' },
  { q: 'What does the agent need from me?', a: 'One permission, with limits you choose. After that it still reads every command back, and your wallet still asks you to approve each transaction. It never sees your keys.' },
  { q: 'Which tokens can I trade?', a: 'On Arc mainnet, every token the aggregator can route that is whitelisted and not flagged as a honeypot or fee-on-transfer. Orders and DCA need a price feed for the token on the contract.' },
  { q: 'Is the contract audited?', a: 'Not yet. It has an extensive test suite and a live test campaign on Arc Testnet, but it is unaudited software.' },
  { q: 'Can I try it without real money?', a: 'Yes. Switch to Testnet. You get test tokens, a test price feed you can move, and a test router, so every order type can be tried.' },
] as const

function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section className="py-10 sm:py-14">
      <Heading kicker="Questions">Asked about this product.</Heading>
      <div className="max-w-3xl border border-line bg-panel">
        {FAQ.map((f, i) => (
          <div key={f.q} className={clsx(i > 0 && 'border-t border-line')}>
            <h3>
              <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} className="flex min-h-[56px] w-full items-center justify-between gap-4 px-4 text-left font-sans text-base font-bold hover:bg-raised">
                {f.q}
                <span className="num text-xl" aria-hidden="true">
                  {open === i ? '-' : '+'}
                </span>
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
                  <p className="px-4 pb-4 text-sm text-mute">{f.a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------- closing ----------

function Closing({ onTrade }: { onTrade: () => void }) {
  return (
    <section className="py-10 sm:py-14">
      <Reveal>
        <div className="border border-line bg-ink p-6 text-canvas shadow-hard-lg sm:p-10">
          <h2 className="max-w-3xl text-4xl leading-tight sm:text-6xl">Try every order type on testnet first.</h2>
          <p className="mt-4 max-w-xl text-sm text-canvas/80">Switch to Testnet, take test tokens from the faucet tool, move the test price, and watch a keeper fill your stop. When it behaves, switch to mainnet.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={onTrade} className="press min-h-[52px] border border-canvas bg-accent px-6 text-base font-bold text-accent-ink shadow-[3px_3px_0_0_rgb(var(--bg))]">
              Open the terminal
            </button>
            <a href={BRAND.links.docs} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[52px] items-center border border-canvas px-6 text-base font-bold hover:bg-canvas hover:text-ink">
              Read the documentation
            </a>
          </div>
        </div>
      </Reveal>
    </section>
  )
}

export function Landing() {
  const { setPage } = useSettings()
  const tryCommand = useCallback(
    (command: string) => {
      setAgentPrefill(command)
      setPage('agent')
    },
    [setPage],
  )
  return (
    <div>
      <Hero onTrade={() => setPage('trade')} onAgent={() => setPage('agent')} />
      <FeatureIndex onTry={tryCommand} />
      <Flow />
      <AgentBand onAgent={() => setPage('agent')} />
      <Tokens />
      <OwnerPowers />
      <Faq />
      <Closing onTrade={() => setPage('trade')} />
    </div>
  )
}
