import { useState } from 'react'
import { Check } from 'lucide-react'
import { clsx } from 'clsx'
import { ACCENTS, SCALES, TIMEFRAME_CHOICES, useSettings, type Accent, type Scale, type ThemePref } from '@/trading/settings'
import { useNowSeconds } from '@/trading/hooks'
import { clearUsage, isGrantActive, loadSpentToday } from '@/trading/agent-permission'
import { Button, Field, Modal, Notice, Segmented, Switch } from './ui'

const PRESETS = [10, 50, 100, 300]
const TABS = [
  { id: 'look', label: 'Look' },
  { id: 'trading', label: 'Trading' },
  { id: 'chart', label: 'Chart' },
  { id: 'agent', label: 'Agent' },
  { id: 'data', label: 'Data' },
] as const
type TabId = (typeof TABS)[number]['id']

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

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-mute">{title}</div>
      {children}
    </div>
  )
}

/** Every setting applies the moment you change it and is remembered on this device. */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings()
  const [tab, setTab] = useState<TabId>('look')
  const [note, setNote] = useState<string | null>(null)

  const exportSettings = () => {
    const { page: _page, ...data } = s
    const blob = new Blob([JSON.stringify({ app: 'arcora', exportedAt: new Date().toISOString(), settings: data }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'arcora-settings.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <Modal open={open} onClose={onClose} title="Settings" wide>
      <div className="mb-4 thin-scroll overflow-x-auto">
        <Segmented className="w-full min-w-max" value={tab} onChange={setTab} options={TABS.map((t) => ({ id: t.id, label: t.label }))} />
      </div>

      {tab === 'look' && (
        <div className="space-y-5">
          <Group title="Theme">
            <Segmented
              className="w-full"
              value={s.themePref}
              onChange={(v: ThemePref) => s.setThemePref(v)}
              options={[
                { id: 'dark', label: 'Dark' },
                { id: 'light', label: 'Light' },
                { id: 'system', label: 'System' },
              ]}
            />
          </Group>
          <Group title="Accent colour">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(ACCENTS) as Accent[]).map((a) => {
                const rgb = ACCENTS[a][s.theme][0]
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => s.set('accent', a)}
                    aria-pressed={s.accent === a}
                    aria-label={ACCENTS[a].label}
                    title={ACCENTS[a].label}
                    className={clsx('grid h-9 w-9 place-items-center rounded-full border-2 transition', s.accent === a ? 'border-ink' : 'border-transparent hover:border-line')}
                    style={{ background: `rgb(${rgb})` }}
                  >
                    {s.accent === a && <Check className="h-4 w-4" style={{ color: `rgb(${ACCENTS[a][s.theme][1]})` }} />}
                  </button>
                )
              })}
            </div>
          </Group>
          <Group title="Interface size">
            <Segmented className="w-full" value={s.scale} onChange={(v: Scale) => s.set('scale', v)} options={(Object.keys(SCALES) as Scale[]).map((k) => ({ id: k, label: SCALES[k].label }))} />
          </Group>
          <Switch checked={s.showNetworkBanner} onChange={(v) => s.set('showNetworkBanner', v)} label="Show the testnet explanation" hint="The short note about test tokens at the top of the trade page" />
        </div>
      )}

      {tab === 'trading' && (
        <div className="space-y-5">
          <Group title="Max slippage">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => s.setSlippageBps(p)}
                  aria-pressed={s.slippageBps === p}
                  className={`num min-h-[32px] rounded-md border px-2.5 text-xs ${s.slippageBps === p ? 'border-accent text-accent' : 'border-line text-mute hover:text-ink'}`}
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
          <NumberSetting label="Order expiry" value={s.expiryDays} min={1} max={365} step="1" right="days" onCommit={(d) => s.setExpiryDays(Math.round(d))} />
          <Group title="Order form opens on">
            <Segmented
              className="w-full"
              value={s.defaultOrderType}
              onChange={(v) => s.set('defaultOrderType', v)}
              options={[
                { id: 'market', label: 'Market' },
                { id: 'limit', label: 'Limit' },
              ]}
            />
          </Group>
          <p className="text-xs text-mute">The contract also checks every fill against its own oracle price, whatever the router quotes. Slippage and expiry apply to the Agent Station too.</p>
        </div>
      )}

      {tab === 'chart' && (
        <div className="space-y-5">
          <Group title="Default timeframe">
            <div className="flex flex-wrap gap-1.5">
              {TIMEFRAME_CHOICES.map((t) => (
                <button
                  key={t}
                  onClick={() => s.set('defaultTimeframe', t)}
                  aria-pressed={s.defaultTimeframe === t}
                  className={`num min-h-[32px] rounded-md border px-3 text-xs ${s.defaultTimeframe === t ? 'border-accent text-accent' : 'border-line text-mute hover:text-ink'}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </Group>
          <Switch checked={s.chartVolume} onChange={(v) => s.set('chartVolume', v)} label="Volume bars" />
          <Switch checked={s.chartMa} onChange={(v) => s.set('chartMa', v)} label="20-period moving average" />
        </div>
      )}

      {tab === 'agent' && (
        <div className="space-y-4">
          <AgentSummary />
        </div>
      )}

      {tab === 'data' && (
        <div className="space-y-4">
          <p className="text-xs text-mute">Settings and recent agent messages live in this browser only. Nothing here is sent to a server.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={exportSettings}>
              Export settings
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                s.resetAll()
                setNote('Settings were reset to the defaults.')
              }}
            >
              Reset all settings
            </Button>
          </div>
          {note && <Notice tone="ok">{note}</Notice>}
        </div>
      )}
    </Modal>
  )
}

function AgentSummary() {
  const s = useSettings()
  const p = s.agent
  const now = useNowSeconds(10_000) * 1000
  const active = isGrantActive(p, now)
  const spent = loadSpentToday(now)
  return (
    <>
      <div className="divide-y divide-line rounded-lg border border-line px-3 text-sm">
        <Line label="Permission" value={active ? 'Granted' : p.granted ? 'Expired' : 'Not granted'} />
        {active && <Line label="Command check" value={p.mode === 'auto' ? 'Run commands inside the limits right away' : 'Ask "is this exact?" every time'} />}
        {active && <Line label="Per command / per day" value={`${p.maxPerCommand} / ${p.dailyLimit} USDC`} />}
        {active && <Line label="Used today" value={`${spent.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`} />}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => s.setPage('agent')}>
          Open Agent Station
        </Button>
        {p.granted && (
          <Button variant="danger" onClick={() => s.setAgent({ ...p, granted: false })}>
            Revoke permission
          </Button>
        )}
        <Button variant="ghost" onClick={() => clearUsage()}>
          Reset today's usage
        </Button>
      </div>
      <p className="text-xs text-mute">Limits and scopes are edited on the Agent Station page. The permission never touches your keys: your wallet still signs every transaction.</p>
    </>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-mute">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
