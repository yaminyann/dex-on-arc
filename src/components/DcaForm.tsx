import { useState } from 'react'
import { useBalances } from '@/trading/hooks'
import { ordersAbi } from '@/trading/ordersAbi'
import { buysForDuration, formatPrice18, formatToken, parsePrice18, parseTokenAmount } from '@/trading/math'
import { FREQUENCIES } from '@/trading/types'
import { Button, Field, Notice, Row, Segmented } from './ui'
import { ConfirmModal, useEscrowFlow, type TradeCtx } from './TradeShared'

export function DcaForm({ ctx }: { ctx: TradeCtx }) {
  const { network, base, address, slippageBps, oracle } = ctx
  const balances = useBalances(network, address)
  const balance = balances.data?.[network.quote.address.toLowerCase()]

  const [amount, setAmount] = useState('')
  const [freq, setFreq] = useState<(typeof FREQUENCIES)[number]['id']>('daily')
  const [days, setDays] = useState('30')
  const [cap, setCap] = useState('')
  const [confirm, setConfirm] = useState(false)

  const interval = FREQUENCIES.find((f) => f.id === freq)!.seconds
  const perBuy = parseTokenAmount(amount, network.quote.decimals)
  const durationDays = Number(days)
  const validDays = Number.isFinite(durationDays) && durationDays >= 1
  const numBuys = validDays ? buysForDuration(durationDays, interval) : 0
  const total = perBuy !== null ? perBuy * BigInt(numBuys) : null
  const capPrice = cap ? parsePrice18(cap) : 0n

  let amountError: string | null = null
  if (amount && perBuy === null) amountError = 'Enter a valid amount'
  if (total !== null && balance !== undefined && total > balance) amountError = `Total budget exceeds your ${network.quote.symbol} balance`
  const capError = cap && !capPrice ? 'Enter a valid price' : null
  const durError = !validDays ? 'At least 1 day' : numBuys > 520 ? 'Too many buys (max 520). Use a lower frequency.' : null

  const flow = useEscrowFlow(network, network.quote, address, network.ordersAddress, total)
  const ready = perBuy !== null && total !== null && !amountError && !capError && !durError && Boolean(network.ordersAddress)

  const submit = async () => {
    if (perBuy === null || !network.ordersAddress) return
    const ok = await flow.run('Create DCA plan', () =>
      flow.tx.write('Create DCA plan', {
        address: network.ordersAddress!,
        abi: ordersAbi,
        functionName: 'createDca',
        args: [base.address, perBuy, numBuys, interval, 0, slippageBps, capPrice ?? 0n],
      }),
    )
    if (ok) {
      setConfirm(false)
      setAmount('')
    }
  }

  return (
    <div className="space-y-3">
      <Field
        label={`Amount per buy (${network.quote.symbol})`}
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={amountError}
        right={network.quote.symbol}
        hint={balance !== undefined ? `Balance ${formatToken(balance, network.quote.decimals, 2)}` : undefined}
      />
      <div>
        <div className="mb-1 text-xs text-mute">Frequency</div>
        <Segmented className="w-full" value={freq} onChange={setFreq} options={FREQUENCIES.map((f) => ({ id: f.id, label: f.label.split(' ')[0] }))} />
      </div>
      <Field label="Duration" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} error={durError} right="days" />
      <Field
        label="Max price per unit (optional)"
        placeholder="No cap"
        value={cap}
        onChange={(e) => setCap(e.target.value)}
        error={capError}
        right={network.quote.symbol}
        hint={oracle ? `Now ${formatPrice18(oracle.price18)}` : undefined}
      />

      <div className="rounded-lg border border-line px-3 py-1.5">
        <Row label="Number of buys" value={numBuys || '-'} />
        <Row label="Total budget (escrowed now)" value={total !== null ? `${formatToken(total, network.quote.decimals, 2)} ${network.quote.symbol}` : '-'} />
        <Row label="Slippage per buy" value={`${(slippageBps / 100).toFixed(2)}%`} />
      </div>

      <Notice>Each buy runs when a keeper submits it after its scheduled time. A buy is skipped while the price is above your cap. You can pause, resume, or cancel and withdraw the rest at any time.</Notice>

      <Button variant="buy" className="w-full" disabled={!ready || !address} onClick={() => setConfirm(true)}>
        {!address ? 'Connect wallet' : 'Review DCA plan'}
      </Button>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Confirm DCA plan"
        rows={[
          ['Buy', base.symbol],
          ['Per buy', `${amount} ${network.quote.symbol}`],
          ['Frequency', FREQUENCIES.find((f) => f.id === freq)!.label],
          ['Buys', String(numBuys)],
          ['Budget escrowed', total !== null ? `${formatToken(total, network.quote.decimals, 2)} ${network.quote.symbol}` : '-'],
          ['Price cap', capPrice ? `${cap} ${network.quote.symbol}` : 'None'],
        ]}
        needsApproval={flow.needsApproval}
        tokenSymbol={network.quote.symbol}
        step={flow.step}
        phase={flow.phase}
        confirmLabel="Create plan"
        onConfirm={() => void submit()}
      />
    </div>
  )
}
