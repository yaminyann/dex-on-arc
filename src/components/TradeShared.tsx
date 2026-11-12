import { useCallback, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { CheckCircle2, Circle, Loader2 } from 'lucide-react'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import type { OracleState } from '@/trading/hooks'
import { useAllowance } from '@/trading/hooks'
import { useTx } from '@/trading/tx'
import { Button, Modal, Notice, Row } from './ui'

export type OkOracle = Extract<OracleState, { status: 'ok' }>

export interface TradeCtx {
  network: NetworkConfig
  base: TokenInfo
  side: number
  oracle: OkOracle | undefined
  address: Address | undefined
  slippageBps: number
  expiryDays: number
}

/** Approve (exact amount, only when needed) then run the action. */
export function useEscrowFlow(network: NetworkConfig, token: TokenInfo, owner: Address | undefined, spender: Address | undefined, amount: bigint | null) {
  const tx = useTx(network)
  const qc = useQueryClient()
  const allowance = useAllowance(network, token.address, owner, spender)
  const needsApproval = Boolean(spender) && amount !== null && (allowance.data ?? 0n) < amount
  const [step, setStep] = useState<'idle' | 'approve' | 'action'>('idle')

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      if (amount === null) return false
      try {
        if (needsApproval && spender) {
          setStep('approve')
          await tx.write(`Approve ${token.symbol}`, { address: token.address, abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
        }
        setStep('action')
        await action()
        void qc.invalidateQueries()
        return true
      } catch {
        return false
      } finally {
        setStep('idle')
        void label
      }
    },
    [spender, amount, needsApproval, tx, token, qc],
  )

  return { run, needsApproval, step, phase: tx.phase, busy: step !== 'idle', tx }
}

export function ConfirmModal({
  open,
  onClose,
  title,
  rows,
  warnings,
  needsApproval,
  tokenSymbol,
  step,
  phase,
  confirmLabel,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  title: string
  rows: [string, ReactNode][]
  warnings?: string[]
  needsApproval: boolean
  tokenSymbol: string
  step: 'idle' | 'approve' | 'action'
  phase: 'idle' | 'wallet' | 'confirming'
  confirmLabel: string
  onConfirm: () => void
}) {
  const busy = step !== 'idle'
  const steps = [
    ...(needsApproval ? [{ id: 'approve', label: `Approve ${tokenSymbol} (exact amount)` }] : []),
    { id: 'action', label: confirmLabel },
  ]
  const activeIdx = steps.findIndex((s) => s.id === step)
  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={title}>
      <div className="divide-y divide-line rounded-lg border border-line px-3">
        {rows.map(([k, v]) => (
          <Row key={k} label={k} value={v} />
        ))}
      </div>
      {warnings && warnings.length > 0 && (
        <div className="mt-3 space-y-2">
          {warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
        </div>
      )}
      <ol className="mt-4 space-y-1.5">
        {steps.map((s, i) => {
          const done = busy && i < activeIdx
          const active = busy && i === activeIdx
          return (
            <li key={s.id} className="flex items-center gap-2 text-xs">
              {done ? <CheckCircle2 className="h-4 w-4 text-up" /> : active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Circle className="h-4 w-4 text-mute" />}
              <span className={active ? 'text-ink' : 'text-mute'}>
                {s.label}
                {active && (phase === 'wallet' ? ' - confirm in wallet' : phase === 'confirming' ? ' - waiting for confirmation' : '')}
              </span>
            </li>
          )
        })}
      </ol>
      <div className="mt-5 flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" className="flex-1" onClick={onConfirm} loading={busy}>
          {busy ? 'Working...' : 'Confirm'}
        </Button>
      </div>
    </Modal>
  )
}

export function BalanceHint({ balance, decimals, symbol, onMax }: { balance: bigint | undefined; decimals: number; symbol: string; onMax: () => void }) {
  return (
    <button type="button" onClick={onMax} className="num inline-flex min-h-[44px] items-center hover:text-ink md:min-h-0">
      {balance === undefined ? '-' : `Max ${Number(balance) / 10 ** decimals > 1e6 ? '>1M' : (Number(balance) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 6 })}`} {symbol}
    </button>
  )
}
