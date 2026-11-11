import { Bot, KeyRound, ListChecks, PenLine, ShieldCheck, Sparkles } from 'lucide-react'
import { Badge, Panel, Segmented } from './ui'
import { useState } from 'react'

/**
 * Prompt Station: layout only. No LLM provider is called, no API key is stored, and nothing here
 * can build or sign a transaction. Future wiring must pass every plan through the same
 * simulation, validation, confirmation and wallet-signature steps as manual orders.
 */
export function PromptStation() {
  const [mode, setMode] = useState<'llm' | 'manual'>('llm')
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Panel className="p-6 text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-accent/15 text-accent">
          <Sparkles className="h-5 w-5" />
        </span>
        <h1 className="mt-3 font-display text-xl font-semibold">Prompt Station</h1>
        <p className="mx-auto mt-1 max-w-md text-sm text-mute">
          Describe a strategy in plain language and review it as a structured order before anything is signed. Coming soon.
        </p>
        <div className="mt-3">
          <Badge tone="accent">Not available yet</Badge>
        </div>
      </Panel>

      <Segmented
        className="w-full"
        value={mode}
        onChange={setMode}
        options={[
          { id: 'llm', label: 'With LLM' },
          { id: 'manual', label: 'Without LLM (manual)' },
        ]}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {mode === 'llm' ? (
          <>
            <Locked icon={<Bot className="h-4 w-4" />} title="Provider" body="Choose a model provider." control={<Fake label="Select provider" />} />
            <Locked icon={<KeyRound className="h-4 w-4" />} title="API key" body="Stored only on your device when released." control={<Fake label="Not configured" />} />
            <Locked icon={<PenLine className="h-4 w-4" />} title="Instruction" body="For example: buy 50 USDC of EURC every Friday." control={<Fake label="Describe your strategy" tall />} wide />
          </>
        ) : (
          <>
            <Locked icon={<ListChecks className="h-4 w-4" />} title="Strategy builder" body="Fill structured fields instead of writing a prompt." control={<Fake label="Pick an order type" />} />
            <Locked icon={<PenLine className="h-4 w-4" />} title="Parameters" body="Amounts, triggers, schedule and limits." control={<Fake label="Configure" />} />
          </>
        )}
        <Locked icon={<ListChecks className="h-4 w-4" />} title="Strategy preview" body="A plan appears here as editable order fields." control={<Fake label="No strategy yet" />} />
        <Locked icon={<ShieldCheck className="h-4 w-4" />} title="Execution confirmation" body="Simulation result, then your wallet signature." control={<Fake label="Nothing to confirm" />} />
      </div>

      <Panel className="p-4 text-xs text-mute">
        <div className="mb-1 font-medium text-ink">Safety rules for the future release</div>
        An AI model will only propose a plan. Every plan will still be validated against contract limits, simulated, shown to you in full, and signed by your own wallet. A model can never skip these steps or hold your keys.
      </Panel>
    </div>
  )
}

function Locked({ icon, title, body, control, wide }: { icon: React.ReactNode; title: string; body: string; control: React.ReactNode; wide?: boolean }) {
  return (
    <Panel className={`p-4 ${wide ? 'sm:col-span-2' : ''}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="text-mute">{icon}</span>
        {title}
      </div>
      <p className="mb-3 mt-1 text-xs text-mute">{body}</p>
      {control}
    </Panel>
  )
}

function Fake({ label, tall }: { label: string; tall?: boolean }) {
  return (
    <div
      aria-disabled="true"
      className={`flex ${tall ? 'min-h-[88px] items-start' : 'min-h-[40px] items-center'} cursor-not-allowed rounded-lg border border-dashed border-line bg-raised/50 px-3 py-2 text-xs text-mute`}
    >
      {label}
    </div>
  )
}
