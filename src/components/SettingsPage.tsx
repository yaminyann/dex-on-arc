import { useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight, ExternalLink } from 'lucide-react'
import { clsx } from 'clsx'
import { BRAND } from '@/brand'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import type { NetworkConfig } from '@/trading/networks'
import { NETWORK_LIST } from '@/trading/networks'
import { ACCENTS, SCALES, TIMEFRAME_CHOICES, useSettings, type Accent, type Density, type Motion, type Scale, type StartPage, type ThemePref, type TimeFormat, type TimeZoneMode, type ToastMode, type ToastPosition } from '@/trading/settings'
import { useBackendHealth, useNowSeconds } from '@/trading/hooks'
import { clearUsage, isGrantActive, loadSpentToday } from '@/trading/agent-permission'
import { SHORTCUTS } from '@/lib/shortcuts'
import { Badge, Button, Field, Notice, Panel, Segmented, Switch } from './ui'

const SECTIONS = [
  { id: 'general', label: 'General', hint: 'Start page, network' },
  { id: 'look', label: 'Look', hint: 'Theme, accent, size, motion' },
  { id: 'display', label: 'Display', hint: 'Time format, hide balances' },
  { id: 'trading', label: 'Trading', hint: 'Slippage, expiry, order form' },
  { id: 'chart', label: 'Chart', hint: 'Style, timeframe, indicators' },
  { id: 'notifications', label: 'Notifications', hint: 'Toasts and where they sit' },
  { id: 'shortcuts', label: 'Shortcuts', hint: 'Keyboard navigation' },
  { id: 'agent', label: 'Agent', hint: 'Permission and limits' },
  { id: 'data', label: 'Data', hint: 'Export, import, reset' },
  { id: 'about', label: 'About', hint: 'Network, contract, links' },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

const PRESETS = [10, 50, 100, 300]

/**
 * A number input that can be cleared and retyped: while focused it keeps its own draft text and only
 * commits a value inside [min, max]. When focus leaves it shows the committed value again.
 */
function NumberSetting({ label, value, min, max, step, right, onCommit }: { label: string; value: number; min: number; max: number; step: string; right: string; onCommit: (n: number) => void }) {
  const [editing, setDraft] = useState<string | null>(null)
  const draft = editing ?? String(value)
  const n = Number(draft)
  const bad = draft.trim() === '' || !Number.isFinite(n) || n < min || n > max
  return (
    <Field
      label={label}
      type="number"
      step={step}
      min={min}
      max={max}
      value={draft}
      error={bad ? `Enter a value from ${min} to ${max}` : null}
      onChange={(e) => {
        setDraft(e.target.value)
        const next = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(next) && next >= min && next <= max) onCommit(next)
      }}
      onBlur={() => setDraft(null)}
      right={right}
    />
  )
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm">{title}</h3>
      {hint && <p className="mb-2 mt-0.5 text-xs text-mute">{hint}</p>}
      <div className={hint ? '' : 'mt-2'}>{children}</div>
    </div>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="num inline-flex min-h-[26px] min-w-[26px] items-center justify-center border border-line bg-raised px-1.5 text-xs font-semibold shadow-hard-sm">{children}</kbd>
}

export function SettingsPage({ network }: { network: NetworkConfig }) {
  const s = useSettings()
  const [section, setSection] = useState<SectionId | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const active = section ?? 'general'
  const current = SECTIONS.find((x) => x.id === active)!

  const exportSettings = () => {
    const { page: _page, ...data } = s
    const blob = new Blob([JSON.stringify({ app: 'lumarc', exportedAt: new Date().toISOString(), settings: data }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'lumarc-settings.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const importSettings = async (file: File) => {
    try {
      if (file.size > 64 * 1024) throw new Error('That file is too large to be a settings export.')
      const json = JSON.parse(await file.text()) as { app?: string; settings?: unknown }
      if (json.app !== 'lumarc' || typeof json.settings !== 'object' || json.settings === null) throw new Error('This is not a Lumarc settings file.')
      s.importSettings(json.settings)
      setNote({ tone: 'ok', text: 'Settings imported. Unknown or out-of-range values were replaced by defaults.' })
    } catch (e) {
      setNote({ tone: 'error', text: e instanceof SyntaxError ? 'That file is not valid JSON. Choose a file exported from this page.' : e instanceof Error ? e.message : 'Could not read that file.' })
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl sm:text-4xl">Settings</h1>
          <p className="mt-1 text-sm text-mute">Every change applies at once and stays on this device.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
        {/* On phones this is the list screen; on wider screens it is a permanent side menu. */}
        <nav aria-label="Settings sections" className={clsx('min-w-0 md:block', section === null ? 'block' : 'hidden')}>
          <ul className="border border-line bg-panel md:sticky md:top-20">
            {SECTIONS.map((x, i) => (
              <li key={x.id} className={clsx(i > 0 && 'border-t border-line')}>
                <button
                  onClick={() => setSection(x.id)}
                  aria-current={section === x.id || (section === null && x.id === 'general') ? 'true' : undefined}
                  className={clsx('flex min-h-[56px] w-full items-center justify-between gap-3 px-4 text-left md:min-h-[48px]', active === x.id ? 'md:bg-accent md:text-accent-ink' : 'hover:bg-raised')}
                >
                  <span>
                    <span className="block text-sm font-bold">{x.label}</span>
                    <span className={clsx('block text-xs md:hidden', 'text-mute')}>{x.hint}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 md:hidden" />
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className={clsx('min-w-0 md:block', section === null ? 'hidden' : 'block')}>
          <button onClick={() => setSection(null)} className="press mb-3 inline-flex min-h-[44px] items-center gap-1 border border-line bg-panel px-3 text-sm font-bold shadow-hard-sm md:hidden">
            Back to settings
          </button>
          <Panel className="p-4 sm:p-5">
            <h2 className="mb-4 text-2xl">{current.label}</h2>
            <div className="space-y-5">
              {active === 'general' && (
                <>
                  <Group title="Open the app on" hint="A link such as /#/agent always wins. A connected wallet always opens Trade, never the landing page.">
                    <Segmented className="w-full" value={s.startPage} onChange={(v: StartPage) => s.set('startPage', v)} options={[{ id: 'home', label: 'Home' }, { id: 'trade', label: 'Trade' }, { id: 'dashboard', label: 'Dashboard' }]} />
                  </Group>
                  <Group title="Network" hint="The network the app reads and trades on right now.">
                    <Segmented className="w-full" value={s.networkKey} onChange={(v) => s.setNetworkKey(v)} options={NETWORK_LIST.map((n) => ({ id: n.key, label: n.isTestnet ? 'Arc Testnet' : 'Arc Mainnet' }))} />
                  </Group>
                  <Switch checked={s.showNetworkBanner} onChange={(v) => s.set('showNetworkBanner', v)} label="Show the testnet explanation" hint="The short note about test tokens at the top of the trade page" />
                </>
              )}

              {active === 'look' && (
                <>
                  <Group title="Theme">
                    <Segmented className="w-full" value={s.themePref} onChange={(v: ThemePref) => s.setThemePref(v)} options={[{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'System' }]} />
                  </Group>
                  <Group title="Accent colour" hint="Used for the main button and the active tab. Text on it is always black.">
                    <div className="flex flex-wrap gap-3">
                      {(Object.keys(ACCENTS) as Accent[]).map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={() => s.set('accent', a)}
                          aria-pressed={s.accent === a}
                          aria-label={ACCENTS[a].label}
                          title={ACCENTS[a].label}
                          className={clsx('press grid h-11 w-11 place-items-center border border-line', s.accent === a ? 'shadow-hard-sm' : '')}
                          style={{ background: `rgb(${ACCENTS[a].rgb})` }}
                        >
                          {s.accent === a && <Check className="h-5 w-5 text-accent-ink" />}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-mute">{ACCENTS[s.accent].label}</p>
                  </Group>
                  <Group title="Interface size">
                    <Segmented className="w-full" value={s.scale} onChange={(v: Scale) => s.set('scale', v)} options={(Object.keys(SCALES) as Scale[]).map((k) => ({ id: k, label: SCALES[k].label }))} />
                  </Group>
                  <Group title="Table density" hint="Compact fits more orders on screen.">
                    <Segmented className="w-full" value={s.density} onChange={(v: Density) => s.set('density', v)} options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }]} />
                  </Group>
                  <Group title="Motion" hint={s.animate ? 'Full adds page transitions and entrances. Reduced keeps short fades. Off removes all of it.' : 'Animation is off here, by this setting or because your system asks for reduced motion.'}>
                    <Segmented className="w-full" value={s.motion} onChange={(v: Motion) => s.set('motion', v)} options={[{ id: 'full', label: 'Full' }, { id: 'reduced', label: 'Reduced' }, { id: 'off', label: 'Off' }]} />
                  </Group>
                </>
              )}

              {active === 'display' && (
                <>
                  <Group title="Time format">
                    <Segmented className="w-full" value={s.timeFormat} onChange={(v: TimeFormat) => s.set('timeFormat', v)} options={[{ id: '24h', label: '24 hour' }, { id: '12h', label: '12 hour' }]} />
                  </Group>
                  <Group title="Time zone" hint="Applies to order and trade times in tables.">
                    <Segmented className="w-full" value={s.timeZone} onChange={(v: TimeZoneMode) => s.set('timeZone', v)} options={[{ id: 'local', label: 'My time zone' }, { id: 'utc', label: 'UTC' }]} />
                  </Group>
                  <Switch checked={s.privacy} onChange={(v) => s.set('privacy', v)} label="Hide balances" hint="Blurs your balance, account value and PnL. Useful on a shared screen." />
                </>
              )}

              {active === 'trading' && (
                <>
                  <Group title="Max slippage">
                    <div className="mb-2 flex flex-wrap gap-2">
                      {PRESETS.map((p) => (
                        <button
                          key={p}
                          onClick={() => s.setSlippageBps(p)}
                          aria-pressed={s.slippageBps === p}
                          className={clsx('num press min-h-[44px] min-w-[64px] border border-line px-3 text-xs font-bold shadow-hard-sm', s.slippageBps === p ? 'bg-accent text-accent-ink' : 'bg-panel hover:bg-raised')}
                        >
                          {(p / 100).toFixed(p % 100 === 0 ? 0 : 1)}%
                        </button>
                      ))}
                    </div>
                    <NumberSetting label="Custom" value={s.slippageBps / 100} min={0.01} max={10} step="0.01" right="%" onCommit={(pct) => s.setSlippageBps(Math.round(pct * 100))} />
                    {s.slippageBps > 100 && (
                      <div className="mt-2">
                        <Notice tone="warn">High slippage lets an order fill at a worse price than expected.</Notice>
                      </div>
                    )}
                  </Group>
                  <Group title="Order expiry">
                    <NumberSetting label="Days until an order expires" value={s.expiryDays} min={1} max={365} step="1" right="days" onCommit={(d) => s.setExpiryDays(Math.round(d))} />
                  </Group>
                  <Group title="Order form opens on">
                    <Segmented className="w-full" value={s.defaultOrderType} onChange={(v) => s.set('defaultOrderType', v)} options={[{ id: 'market', label: 'Market' }, { id: 'limit', label: 'Limit' }]} />
                  </Group>
                  <p className="text-xs text-mute">The contract also checks every fill against its own oracle price, whatever the router quotes. Slippage and expiry apply to the Agent as well.</p>
                </>
              )}

              {active === 'chart' && (
                <>
                  <Group title="Chart style">
                    <Segmented className="w-full" value={s.chartType} onChange={(v) => s.set('chartType', v)} options={[{ id: 'candles', label: 'Candles' }, { id: 'line', label: 'Line' }]} />
                  </Group>
                  <Group title="Default timeframe">
                    <div className="flex flex-wrap gap-2">
                      {TIMEFRAME_CHOICES.map((t) => (
                        <button key={t} onClick={() => s.set('defaultTimeframe', t)} aria-pressed={s.defaultTimeframe === t} className={clsx('num press min-h-[44px] min-w-[52px] border border-line px-3 text-xs font-bold shadow-hard-sm', s.defaultTimeframe === t ? 'bg-accent text-accent-ink' : 'bg-panel hover:bg-raised')}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </Group>
                  <Switch checked={s.chartVolume} onChange={(v) => s.set('chartVolume', v)} label="Volume bars" />
                  <Switch checked={s.chartMa} onChange={(v) => s.set('chartMa', v)} label="20-period moving average" />
                </>
              )}

              {active === 'notifications' && (
                <>
                  <Group title="Show notifications" hint="Transaction results appear as small toasts. Errors only keeps failures and hides the rest.">
                    <Segmented className="w-full" value={s.toasts} onChange={(v: ToastMode) => s.set('toasts', v)} options={[{ id: 'all', label: 'All' }, { id: 'errors', label: 'Errors only' }, { id: 'off', label: 'Off' }]} />
                  </Group>
                  {s.toasts !== 'off' && (
                    <Group title="Position">
                      <Segmented className="w-full" value={s.toastPosition} onChange={(v: ToastPosition) => s.set('toastPosition', v)} options={[{ id: 'top-center', label: 'Top' }, { id: 'bottom-center', label: 'Bottom' }, { id: 'bottom-right', label: 'Bottom right' }]} />
                    </Group>
                  )}
                  {s.toasts === 'off' && <Notice tone="warn">With notifications off you will not see a failed transaction. The order tables still show the result.</Notice>}
                </>
              )}

              {active === 'shortcuts' && (
                <>
                  <Switch checked={s.shortcuts} onChange={(v) => s.set('shortcuts', v)} label="Keyboard shortcuts" hint="Press g, then a letter. Ignored while you type in a field." />
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-line">
                        <th className="py-2 font-bold">Go to</th>
                        <th className="py-2 font-bold">Keys</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SHORTCUTS.map((k) => (
                        <tr key={k.keys} className="border-b border-line/50">
                          <td className="py-2">{k.label}</td>
                          <td className="py-2">
                            <span className="inline-flex gap-1.5">
                              {k.keys.split(' ').map((c) => (
                                <Kbd key={c}>{c}</Kbd>
                              ))}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {active === 'agent' && <AgentSummary />}

              {active === 'data' && (
                <>
                  <p className="text-sm text-mute">Settings, the agent permission and your market-swap history live in this browser only. An exported file holds settings and agent limits, never keys.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={exportSettings}>Export settings</Button>
                    <Button onClick={() => fileInput.current?.click()}>Import settings</Button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void importSettings(f)
                        e.target.value = ''
                      }}
                    />
                  </div>
                  <Group title="Clear saved data">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="danger"
                        onClick={() => {
                          localStorage.removeItem('arc-terminal-market-trades-v1')
                          setNote({ tone: 'ok', text: 'Saved market-swap history was cleared. The chain still has the transactions.' })
                        }}
                      >
                        Clear swap history
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          s.resetAll()
                          setNote({ tone: 'ok', text: 'Settings were reset to the defaults.' })
                        }}
                      >
                        Reset all settings
                      </Button>
                    </div>
                  </Group>
                  {note && <Notice tone={note.tone}>{note.text}</Notice>}
                </>
              )}

              {active === 'about' && <About network={network} />}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function AgentSummary() {
  const s = useSettings()
  const p = s.agent
  const now = useNowSeconds(10_000) * 1000
  const on = isGrantActive(p, now)
  const spent = loadSpentToday(now)
  const row = (k: string, v: string) => (
    <div className="flex items-center justify-between gap-3 border-b border-line/50 py-2 text-sm last:border-b-0">
      <span className="text-mute">{k}</span>
      <span className="text-right font-semibold">{v}</span>
    </div>
  )
  return (
    <>
      <div className="border border-line">
        <div className="px-3">
          {row('Permission', on ? 'Granted' : p.granted ? 'Expired' : 'Not granted')}
          {on && row('Command check', p.mode === 'auto' ? 'Run commands inside the limits right away' : 'Ask "is this exact?" every time')}
          {on && row('Per command', `${p.maxPerCommand} USDC`)}
          {on && row('Per day', `${p.dailyLimit} USDC`)}
          {on && row('Used today', `${spent.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`)}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => s.setPage('agent')}>
          Open the Agent
        </Button>
        {p.granted && (
          <Button variant="danger" onClick={() => s.setAgent({ ...p, granted: false })}>
            Revoke permission
          </Button>
        )}
        <Button onClick={() => clearUsage()}>Reset today's usage</Button>
      </div>
      <p className="text-xs text-mute">Limits and scopes are edited on the Agent page. The permission never touches your keys: your wallet still signs every transaction.</p>
    </>
  )
}

function About({ network }: { network: NetworkConfig }) {
  const health = useBackendHealth()
  const r = (k: string, v: ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line/50 py-2.5 text-sm last:border-b-0">
      <span className="text-mute">{k}</span>
      <span className="text-right font-semibold">{v}</span>
    </div>
  )
  return (
    <>
      <div className="border border-line px-3">
        {r('App', BRAND.name)}
        {r('Network', `${network.label} (chain ${network.chainId})`)}
        {r('Backend', health.isSuccess ? <Badge tone="up">Online</Badge> : health.isLoading ? 'Checking' : <Badge tone="down">Offline</Badge>)}
        {r('Keeper', health.data?.keeper.running ? <Badge tone="up">Running</Badge> : <Badge>Not running</Badge>)}
        {r(
          'Order contract',
          network.ordersAddress ? (
            <a href={buildAddressExplorerUrl(network.chainId, network.ordersAddress)} target="_blank" rel="noopener noreferrer" className="num inline-flex items-center gap-1 underline underline-offset-2">
              {network.ordersAddress.slice(0, 8)}...{network.ordersAddress.slice(-6)} <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            'Not set on this network'
          ),
        )}
        {r('Platform fee', health.data?.platformFee ? `${(health.data.platformFee.bps / 100).toFixed(2)}% on market swaps` : 'None')}
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={BRAND.links.docs} target="_blank" rel="noopener noreferrer" className="press inline-flex min-h-[44px] items-center gap-2 border border-line bg-panel px-4 text-sm font-bold shadow-hard-sm hover:bg-raised">
          Documentation <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <a href={BRAND.links.github} target="_blank" rel="noopener noreferrer" className="press inline-flex min-h-[44px] items-center gap-2 border border-line bg-panel px-4 text-sm font-bold shadow-hard-sm hover:bg-raised">
          Source code <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <p className="text-xs text-mute">The order contract is unaudited. Read the risk notice in the footer before you put real funds into an order.</p>
    </>
  )
}
