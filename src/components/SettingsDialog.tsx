import { useState } from 'react'
import { Modal, Field, Notice } from './ui'
import { useSettings } from '@/trading/settings'

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

/** Theme lives in the header. Only the values that change what an order does are here. */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings()
  return (
    <Modal open={open} onClose={onClose} title="Trading settings">
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 text-xs text-mute">Max slippage</div>
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
        </div>

        <NumberSetting label="Order expiry" value={s.expiryDays} min={1} max={365} step="1" right="days" onCommit={(d) => s.setExpiryDays(Math.round(d))} />

        <p className="text-xs text-mute">The contract also checks every fill against its own oracle price, whatever the router quotes.</p>
      </div>
    </Modal>
  )
}
