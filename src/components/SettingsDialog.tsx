import { Modal, Segmented, Field, Notice } from './ui'
import { useSettings } from '@/trading/settings'

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings()
  const presets = [10, 50, 100, 300]
  return (
    <Modal open={open} onClose={onClose} title="Settings">
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 text-xs text-mute">Theme</div>
          <Segmented
            value={s.theme}
            onChange={s.setTheme}
            options={[
              { id: 'dark', label: 'Dark' },
              { id: 'light', label: 'Light' },
            ]}
          />
        </div>

        <div>
          <div className="mb-1.5 text-xs text-mute">Default slippage</div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p}
                onClick={() => s.setSlippageBps(p)}
                className={`num min-h-[32px] rounded-md border px-2.5 text-xs ${s.slippageBps === p ? 'border-accent text-accent' : 'border-line text-mute hover:text-ink'}`}
              >
                {(p / 100).toFixed(p % 100 === 0 ? 0 : 1)}%
              </button>
            ))}
          </div>
          <Field
            label="Custom (percent, 0.01 to 10)"
            type="number"
            step="0.01"
            value={(s.slippageBps / 100).toString()}
            onChange={(e) => s.setSlippageBps(Math.round(Number(e.target.value) * 100))}
            right="%"
          />
          {s.slippageBps > 100 && (
            <div className="mt-2">
              <Notice tone="warn">High slippage lets a swap fill at a worse price than expected.</Notice>
            </div>
          )}
        </div>

        <Field
          label="Default order expiry"
          type="number"
          min={1}
          max={365}
          value={String(s.expiryDays)}
          onChange={(e) => s.setExpiryDays(Number(e.target.value))}
          right="days"
        />

        <Notice>
          The contract caps slippage at 10% and always checks swap output against its own oracle price, whatever the aggregator quotes.
        </Notice>
      </div>
    </Modal>
  )
}
