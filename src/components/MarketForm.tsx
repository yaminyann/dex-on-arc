import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { Amount, gasTokenToUsdc } from '@/onchain-money'
import { AggregatorError, getAggregator } from '@/trading/aggregator'
import { useBackendHealth, useBalances } from '@/trading/hooks'
import { addLocalTrade } from '@/trading/localTrades'
import { formatPrice18, formatToken, pctDiff, parseTokenAmount, toInputString, WAD } from '@/trading/math'
import { Side } from '@/trading/types'
import { Button, Field, Notice, Row, Skeleton } from './ui'
import { BalanceHint, ConfirmModal, useEscrowFlow, type TradeCtx } from './TradeShared'

export function MarketForm({ ctx }: { ctx: TradeCtx }) {
  const { network, base, side, address, slippageBps, oracle } = ctx
  const buy = side === Side.BUY
  const sellToken = buy ? network.quote : base
  const buyToken = buy ? base : network.quote
  const balances = useBalances(network, address)
  const balance = balances.data?.[sellToken.address.toLowerCase()]
  const health = useBackendHealth()

  const [amount, setAmount] = useState('')
  const [confirm, setConfirm] = useState(false)
  const sellAmount = parseTokenAmount(useDeferredValue(amount), sellToken.decimals)
  const aggregator = getAggregator(network)
  const unavailable = aggregator.unavailableReason()
  const keyMissing = aggregator.id === '0x' && !unavailable && health.data && !health.data.zeroEx.configured
  const backendDown = !unavailable && health.isError

  const price = useQuery({
    queryKey: ['swap-price', network.key, sellToken.address, buyToken.address, sellAmount?.toString(), address, slippageBps],
    enabled: Boolean(sellAmount && address && !unavailable && !keyMissing && !backendDown),
    staleTime: 8_000,
    refetchInterval: 12_000,
    retry: false,
    queryFn: () =>
      aggregator.price({ chainId: network.chainId, sellToken: sellToken.address, buyToken: buyToken.address, sellAmount: sellAmount!, taker: address as Address, slippageBps }),
  })
  const q = price.data
  const fee = q?.networkFeeNative ? gasTokenToUsdc(network.chainId, Amount.fromRaw(q.networkFeeNative, 18)).raw : null

  // Implied execution price (quote per whole base) vs the contract oracle, as a sanity check.
  let impliedVsOracle: number | null = null
  if (q && oracle) {
    const quoteAmt = buy ? q.sellAmount : q.buyAmount
    const baseAmt = buy ? q.buyAmount : q.sellAmount
    if (baseAmt > 0n) {
      const implied = (quoteAmt * WAD * 10n ** BigInt(base.decimals)) / (baseAmt * 10n ** BigInt(network.quote.decimals))
      impliedVsOracle = pctDiff(implied, oracle.price18)
    }
  }

  const flow = useEscrowFlow(network, sellToken, address, q?.allowanceSpender ?? undefined, sellAmount)

  const execute = async () => {
    if (!sellAmount || !address) return
    const ok = await flow.run('Swap', async () => {
      const firm = await aggregator.quote({ chainId: network.chainId, sellToken: sellToken.address, buyToken: buyToken.address, sellAmount, taker: address, slippageBps })
      if (!firm?.transaction) throw new AggregatorError('NO_ROUTE', 'No executable route right now.')
      const receipt = await flow.tx.send('Swap', { to: firm.transaction.to, data: firm.transaction.data, value: firm.transaction.value })
      addLocalTrade({
        hash: receipt.transactionHash,
        chainId: network.chainId,
        time: Math.floor(Date.now() / 1000),
        side,
        baseSymbol: base.symbol,
        sellAmount: formatToken(sellAmount, sellToken.decimals, 6),
        sellSymbol: sellToken.symbol,
        minBuyAmount: formatToken(firm.minBuyAmount, buyToken.decimals, 6),
        buySymbol: buyToken.symbol,
      })
    })
    if (ok) {
      setConfirm(false)
      setAmount('')
    }
  }

  if (unavailable) {
    return (
      <Notice tone="warn" title="Market swaps are unavailable here">
        {unavailable} Switch to Arc mainnet in the header to use swaps. No quote is shown because none exists.
      </Notice>
    )
  }

  const errMsg = price.error instanceof Error ? price.error.message : null

  return (
    <div className="space-y-3">
      {keyMissing && (
        <Notice tone="warn" title="0x API key missing">
          Add ZEROEX_API_KEY to .env and restart the backend (`bun run server`).
        </Notice>
      )}
      {backendDown && (
        <Notice tone="warn" title="Quote service offline">
          Start the backend with `bun run server`.
        </Notice>
      )}
      <Field
        label={`Sell (${sellToken.symbol})`}
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        right={sellToken.symbol}
        error={amount && sellAmount === null ? 'Enter a valid amount' : sellAmount !== null && balance !== undefined && sellAmount > balance ? 'Exceeds your balance' : null}
        hint={<BalanceHint balance={balance} decimals={sellToken.decimals} symbol="" onMax={() => balance !== undefined && setAmount(toInputString(balance, sellToken.decimals))} />}
      />

      <div className="rounded-lg border border-line px-3 py-1.5">
        {price.isFetching && !q ? (
          <Skeleton className="my-2 h-16" />
        ) : q ? (
          <>
            <Row label="You receive (est.)" value={`${formatToken(q.buyAmount, buyToken.decimals, 6)} ${buyToken.symbol}`} />
            <Row label="Minimum received" value={`${formatToken(q.minBuyAmount, buyToken.decimals, 6)} ${buyToken.symbol}`} />
            <Row label="Slippage" value={`${(slippageBps / 100).toFixed(2)}%`} />
            <Row
              label="Vs oracle price"
              value={impliedVsOracle === null ? '-' : `${impliedVsOracle > 0 ? '+' : ''}${(impliedVsOracle * 100).toFixed(2)}%`}
              tone={impliedVsOracle !== null && Math.abs(impliedVsOracle) > 0.01 ? 'down' : undefined}
            />
            <Row label="Network fee" value={fee === null ? '-' : fee === 0n ? '< 0.000001 USDC' : `${formatToken(fee, 6, 6)} USDC`} />
            <Row
              label="Route"
              value={q.route.length ? q.route.map((r) => `${r.source} ${Number(r.proportionBps) / 100}%`).join(', ') : '-'}
            />
            {oracle && <Row label="Oracle price" value={formatPrice18(oracle.price18)} tone="mute" />}
          </>
        ) : errMsg ? (
          <div className="py-2 text-xs text-down">{errMsg}</div>
        ) : price.isSuccess ? (
          <div className="py-2 text-xs text-mute">No route has liquidity for this size. Try a smaller amount.</div>
        ) : (
          <div className="py-2 text-xs text-mute">{address ? 'Enter an amount to get a live quote.' : 'Connect a wallet to get a quote.'}</div>
        )}
      </div>

      <Button variant={buy ? 'buy' : 'sell'} className="w-full" disabled={!q || !address || (sellAmount !== null && balance !== undefined && sellAmount > balance)} onClick={() => setConfirm(true)}>
        {!address ? 'Connect wallet' : `${buy ? 'Buy' : 'Sell'} ${base.symbol}`}
      </Button>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`${buy ? 'Buy' : 'Sell'} ${base.symbol}`}
        rows={[
          ['Sell', `${amount} ${sellToken.symbol}`],
          ['Receive at least', q ? `${formatToken(q.minBuyAmount, buyToken.decimals, 6)} ${buyToken.symbol}` : '-'],
          ['Slippage', `${(slippageBps / 100).toFixed(2)}%`],
        ]}
        warnings={impliedVsOracle !== null && Math.abs(impliedVsOracle) > 0.02 ? ['This quote is more than 2% away from the oracle price.'] : undefined}
        needsApproval={flow.needsApproval}
        tokenSymbol={sellToken.symbol}
        step={flow.step}
        phase={flow.phase}
        confirmLabel="Swap"
        onConfirm={() => void execute()}
      />
    </div>
  )
}
