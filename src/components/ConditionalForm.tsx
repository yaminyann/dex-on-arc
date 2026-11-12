import { useMemo, useState } from 'react'
import { useBalances } from '@/trading/hooks'
import { ordersAbi } from '@/trading/ordersAbi'
import { OrderType, ORDER_TYPE_LABEL, Side } from '@/trading/types'
import {
  applySlippage,
  baseForQuote,
  formatPrice18,
  formatToken,
  parsePrice18,
  parseTokenAmount,
  quoteForBase,
  toInputString,
} from '@/trading/math'
import { Button, Field, Notice, Row } from './ui'
import { BalanceHint, ConfirmModal, useEscrowFlow, type TradeCtx } from './TradeShared'

export type ConditionalKind = 'limit' | 'stop_loss' | 'take_profit' | 'stop_limit' | 'trailing' | 'oco'

const KIND_TYPE: Record<ConditionalKind, number> = {
  limit: OrderType.LIMIT,
  stop_loss: OrderType.STOP_LOSS,
  take_profit: OrderType.TAKE_PROFIT,
  stop_limit: OrderType.STOP_LIMIT,
  trailing: OrderType.TRAILING_STOP,
  oco: OrderType.OCO,
}

export function ConditionalForm({ ctx, kind }: { ctx: TradeCtx; kind: ConditionalKind }) {
  const { network, base, side, oracle, address, slippageBps, expiryDays } = ctx
  const buy = side === Side.BUY
  const escrowToken = buy ? network.quote : base
  const balances = useBalances(network, address)
  const balance = balances.data?.[escrowToken.address.toLowerCase()]

  const [amount, setAmount] = useState('')
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [trail, setTrail] = useState('5')
  const [confirm, setConfirm] = useState(false)

  const amountIn = parseTokenAmount(amount, escrowToken.decimals)
  const price = oracle?.price18 ?? 0n
  const first = parsePrice18(p1)
  const second = parsePrice18(p2)
  const trailBps = Math.round(Number(trail) * 100)

  const flow = useEscrowFlow(network, escrowToken, address, network.ordersAddress, amountIn)

  const labels = useMemo(() => {
    switch (kind) {
      case 'limit':
        return { a: buy ? 'Buy at or below' : 'Sell at or above', b: null }
      case 'stop_loss':
        return { a: 'Stop price (sell when price falls to)', b: null }
      case 'take_profit':
        return { a: 'Target price (sell when price rises to)', b: null }
      case 'stop_limit':
        return { a: 'Stop price', b: 'Limit price (worst acceptable fill)' }
      case 'oco':
        return { a: 'Stop-loss price', b: 'Take-profit price' }
      default:
        return { a: null, b: null }
    }
  }, [kind, buy])

  // Mirrors the contract's creation checks so the user sees the problem before signing.
  const problems: Record<string, string | null> = { a: null, b: null, trail: null, amount: null }
  if (amount && amountIn === null) problems.amount = 'Enter a valid amount'
  if (amountIn !== null && balance !== undefined && amountIn > balance) problems.amount = `Exceeds your ${escrowToken.symbol} balance`
  if (price > 0n) {
    if (kind === 'stop_loss' || kind === 'stop_limit') {
      if (p1 && first && first >= price) problems.a = 'Must be below the current oracle price'
    }
    if (kind === 'take_profit' && p1 && first && first <= price) problems.a = 'Must be above the current oracle price'
    if (kind === 'oco') {
      if (p1 && first && first >= price) problems.a = 'Stop must be below the current price'
      if (p2 && second && second <= price) problems.b = 'Take-profit must be above the current price'
    }
  }
  if (kind === 'stop_limit' && first && second && second > first) problems.b = 'Limit must not be above the stop price'
  if (kind === 'trailing' && (trailBps < 10 || trailBps > 5000)) problems.trail = 'Between 0.1% and 50%'
  if (p1 && !first) problems.a = 'Enter a valid price'
  if (p2 && !second) problems.b = 'Enter a valid price'

  const needA = kind !== 'trailing'
  const needB = kind === 'stop_limit' || kind === 'oco'
  const ready =
    amountIn !== null &&
    (!needA || first !== null) &&
    (!needB || second !== null) &&
    Object.values(problems).every((p) => p === null) &&
    price > 0n &&
    Boolean(network.ordersAddress)

  // Estimate at the user's execution price (or the oracle price when none applies).
  const execPrice = kind === 'stop_limit' ? (second ?? first) : kind === 'oco' ? first : (first ?? price)
  const estimate =
    amountIn && execPrice
      ? buy
        ? baseForQuote(amountIn, execPrice, base.decimals, network.quote.decimals)
        : quoteForBase(amountIn, execPrice, base.decimals, network.quote.decimals)
      : null
  const outToken = buy ? base : network.quote
  const floor = estimate !== null ? applySlippage(estimate, slippageBps) : null

  const submit = async () => {
    if (!amountIn || !network.ordersAddress) return
    const expiry = Math.floor(Date.now() / 1000) + expiryDays * 86400
    const ok = await flow.run('Create order', () =>
      flow.tx.write('Create order', {
        address: network.ordersAddress!,
        abi: ordersAbi,
        functionName: 'createOrder',
        args: [
          {
            base: base.address,
            side,
            orderType: KIND_TYPE[kind],
            amountIn,
            triggerPrice: kind === 'trailing' ? 0n : (first ?? 0n),
            limitPrice: needB ? (second ?? 0n) : 0n,
            trailBps: kind === 'trailing' ? trailBps : 0,
            maxSlippageBps: slippageBps,
            expiry,
          },
        ],
      }),
    )
    if (ok) {
      setConfirm(false)
      setAmount('')
      setP1('')
      setP2('')
    }
  }

  const rows: [string, React.ReactNode][] = [
    ['Order', `${ORDER_TYPE_LABEL[KIND_TYPE[kind]]} ${buy ? 'buy' : 'sell'} ${base.symbol}`],
    ['Escrowed', `${amount} ${escrowToken.symbol}`],
    ...(kind === 'trailing' ? ([['Trailing distance', `${trail}%`]] as [string, string][]) : []),
    ...(first ? ([[labels.a ?? 'Price', `${p1} ${network.quote.symbol}`]] as [string, string][]) : []),
    ...(needB && second ? ([[labels.b ?? 'Price', `${p2} ${network.quote.symbol}`]] as [string, string][]) : []),
    ['Max slippage', `${(slippageBps / 100).toFixed(2)}%`],
    ['Expires', `${expiryDays} days`],
    ...(floor !== null ? ([['Contract minimum output', `${formatToken(floor, outToken.decimals, 6)} ${outToken.symbol}`]] as [string, string][]) : []),
  ]

  const warnings: string[] = []
  if (kind === 'stop_limit') warnings.push('A triggered stop-limit order is not guaranteed to fill. If the market is worse than your limit, it stays open until it expires.')
  if (kind === 'trailing') warnings.push('A keeper must record new price highs for the trailing stop to follow the market. Without one running, the stop can sit lower than expected.')
  warnings.push('Funds are escrowed in the order contract until it fills, you cancel, or it expires. You can cancel at any time.')

  return (
    <div className="space-y-3">
      <Field
        label={buy ? `Spend (${network.quote.symbol})` : `Sell (${base.symbol})`}
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={problems.amount}
        right={escrowToken.symbol}
        hint={
          <BalanceHint
            balance={balance}
            decimals={escrowToken.decimals}
            symbol=""
            onMax={() => balance !== undefined && setAmount(toInputString(balance, escrowToken.decimals))}
          />
        }
      />
      <div className="flex gap-1.5">
        {[25, 50, 75, 100].map((pct) => (
          <button
            key={pct}
            type="button"
            disabled={balance === undefined}
            onClick={() => balance !== undefined && setAmount(toInputString((balance * BigInt(pct)) / 100n, escrowToken.decimals))}
            className="num min-h-[30px] flex-1 rounded-md border border-line text-xs text-mute hover:text-ink disabled:opacity-40"
          >
            {pct}%
          </button>
        ))}
      </div>

      {needA && (
        <Field
          label={labels.a ?? ''}
          placeholder={price > 0n ? formatPrice18(price) : '0.00'}
          value={p1}
          onChange={(e) => setP1(e.target.value)}
          error={problems.a}
          right={network.quote.symbol}
          hint={price > 0n ? `Now ${formatPrice18(price)}` : undefined}
        />
      )}
      {needB && (
        <Field label={labels.b ?? ''} placeholder="0.00" value={p2} onChange={(e) => setP2(e.target.value)} error={problems.b} right={network.quote.symbol} />
      )}
      {kind === 'trailing' && (
        <Field label="Trailing distance" type="number" step="0.1" value={trail} onChange={(e) => setTrail(e.target.value)} error={problems.trail} right="%" />
      )}

      <div className="rounded-lg border border-line px-3 py-1.5">
        <Row label="Estimated receive" value={estimate !== null ? `${formatToken(estimate, outToken.decimals, 6)} ${outToken.symbol}` : '-'} />
        <Row label="Contract minimum" value={floor !== null ? `${formatToken(floor, outToken.decimals, 6)} ${outToken.symbol}` : '-'} />
        <Row label="Slippage" value={`${(slippageBps / 100).toFixed(2)}%`} />
        <Row label="Execution" value="Keeper pays gas, takes up to 0.10% of output" tone="mute" />
      </div>

      {kind === 'oco' && <Notice>One escrow, two exits: whichever price is hit first executes, and the other can never run.</Notice>}

      <Button variant={buy ? 'buy' : 'sell'} className="w-full" disabled={!ready || !address} onClick={() => setConfirm(true)}>
        {!address ? 'Connect wallet' : `Review ${ORDER_TYPE_LABEL[KIND_TYPE[kind]]} order`}
      </Button>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Confirm order"
        rows={rows}
        warnings={warnings}
        needsApproval={flow.needsApproval}
        tokenSymbol={escrowToken.symbol}
        step={flow.step}
        phase={flow.phase}
        confirmLabel="Create order"
        onConfirm={() => void submit()}
      />
    </div>
  )
}
