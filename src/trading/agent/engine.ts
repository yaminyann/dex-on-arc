/**
 * Turns a parsed command into a checked plan and, once confirmed, runs it through the same contract calls
 * the forms use. Nothing here signs anything: every transaction goes to the connected wallet, which asks
 * for its own approval. The plan is built from live data (balances, oracle, quotes) so the confirmation
 * the user reads is the exact thing that will be sent.
 */
import { useCallback } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { erc20Abi, formatUnits, type Address, type Hex } from 'viem'
import type { NetworkConfig, TokenInfo } from '../networks'
import { useTokenList } from '../tokens'
import { useAccountSummary } from '../account'
import { useTx } from '../tx'
import { useSettings } from '../settings'
import { AggregatorError, getAggregator } from '../aggregator'
import { readOracle } from '../hooks'
import { ordersAbi } from '../ordersAbi'
import { reportSwap } from '../history'
import { addLocalTrade } from '../localTrades'
import { applySlippage, baseForQuote, buysForDuration, formatPrice18, formatToken, parsePrice18, parseTokenAmount, quoteForBase } from '../math'
import { DcaStatus, FREQUENCIES, ORDER_TYPE_LABEL, OrderType, Side, Status } from '../types'
import type { AgentScope } from '../agent-permission'
import type { Amount, Intent } from './parser'
import { HELP_LINES } from './parser'

export interface RunResult {
  summary: string
  hashes: Hex[]
}

export interface Plan {
  scope: AgentScope
  title: string
  /** The exact terms, shown for the user to check. */
  lines: [string, string][]
  warnings: string[]
  /** Size in USDC for the permission limits, or null when it cannot be priced. */
  valueUsdc: number | null
  builtAt: number
  run: (progress: (message: string) => void) => Promise<RunResult>
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string }
export type Answer = { lines: [string, string][]; text?: string }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const usdcNumber = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals))
const fail = (error: string): PlanResult => ({ ok: false, error })

export function useAgentEngine(network: NetworkConfig) {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: network.chainId })
  const tx = useTx(network)
  const { slippageBps, expiryDays } = useSettings()
  const tokens = useTokenList(network).tokens
  const account = useAccountSummary(network)
  const q = network.quote

  const resolveToken = useCallback(
    (name: string): { token: TokenInfo } | { error: string } => {
      // The token list already holds exactly what can be traded on this network (on testnet, only tokens with a test feed).
      const all = tokens
      if (ADDRESS.test(name)) {
        const hit = all.find((t) => t.address.toLowerCase() === name.toLowerCase())
        return hit ? { token: hit } : { error: `That address is not in the ${network.label} token list.` }
      }
      if (name.toLowerCase() === q.symbol.toLowerCase()) return { error: `${q.symbol} is the currency you trade against. Pick another token.` }
      const hits = all.filter((t) => t.symbol.toLowerCase() === name.toLowerCase())
      if (hits.length === 1) return { token: hits[0] }
      if (hits.length > 1) return { error: `More than one token is called ${name}. Use its contract address:\n${hits.map((t) => `${t.symbol} ${t.address}`).join('\n')}` }
      const sample = all.slice(0, 5).map((t) => t.symbol).join(', ')
      return { error: `I do not know a token called "${name}" on ${network.label}. Tradable here: ${sample}${all.length > 5 ? ', ...' : ''}.` }
    },
    [network.label, tokens, q.symbol],
  )

  const balanceOf = useCallback(
    async (token: Address): Promise<bigint> => {
      if (!client || !address) return 0n
      return client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
    },
    [client, address],
  )

  const resolveAmount = useCallback(
    async (amount: Amount, token: TokenInfo): Promise<{ value: bigint } | { error: string }> => {
      const balance = await balanceOf(token.address)
      let value: bigint | null
      if (amount.kind === 'all') value = balance
      else if (amount.kind === 'percent') value = (balance * BigInt(Math.round(amount.value * 100))) / 10_000n
      else value = parseTokenAmount(amount.value, token.decimals)
      if (value === null) return { error: `"${amount.kind === 'usdc' || amount.kind === 'token' ? amount.value : ''}" is not a valid ${token.symbol} amount (up to ${token.decimals} decimals).` }
      if (value <= 0n) return { error: `You have no ${token.symbol} to use.` }
      if (value > balance) return { error: `You only have ${formatToken(balance, token.decimals, 6)} ${token.symbol}.` }
      return { value }
    },
    [balanceOf],
  )

  /** Exact-amount approval, only when the allowance is short. */
  const ensureAllowance = useCallback(
    async (token: TokenInfo, spender: Address, amount: bigint, progress: (m: string) => void, hashes: Hex[]) => {
      if (!client || !address) throw new Error('Connect a wallet first.')
      const have = await client.readContract({ address: token.address, abi: erc20Abi, functionName: 'allowance', args: [address, spender] })
      if (have >= amount) return
      progress(`Approve ${token.symbol} in your wallet…`)
      const r = await tx.write(`Approve ${token.symbol}`, { address: token.address, abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
      hashes.push(r.transactionHash)
    },
    [client, address, tx],
  )

  // ---------- market swaps ----------
  const planSwap = useCallback(
    async (side: 'buy' | 'sell', tokenName: string, amount: Amount): Promise<PlanResult> => {
      if (!address) return fail('Connect your wallet first.')
      const r = resolveToken(tokenName)
      if ('error' in r) return fail(r.error)
      const base = r.token
      const agg = getAggregator(network)
      const unavailable = agg.unavailableReason()
      if (unavailable) return fail(`Market swaps are not available here. ${unavailable}`)

      const sellToken = side === 'buy' ? q : base
      const buyToken = side === 'buy' ? base : q
      const a = await resolveAmount(amount, sellToken)
      if ('error' in a) return fail(a.error)
      const sellAmount = a.value
      const req = { chainId: network.chainId, sellToken: sellToken.address, buyToken: buyToken.address, sellAmount, taker: address, slippageBps }

      let quote
      try {
        quote = await agg.price(req)
      } catch (e) {
        return fail(e instanceof Error ? e.message : 'The quote service did not answer.')
      }
      if (!quote) return fail(`No route has liquidity for ${formatToken(sellAmount, sellToken.decimals, 6)} ${sellToken.symbol}. Try a smaller amount.`)

      const lines: [string, string][] = [
        ['Action', `Market ${side} ${base.symbol}`],
        [side === 'buy' ? 'You spend' : 'You sell', `${formatToken(sellAmount, sellToken.decimals, 6)} ${sellToken.symbol}`],
        ['You receive (est.)', `${formatToken(quote.buyAmount, buyToken.decimals, 6)} ${buyToken.symbol}`],
        ['Minimum received', `${formatToken(quote.minBuyAmount, buyToken.decimals, 6)} ${buyToken.symbol}`],
        ['Max slippage', `${(slippageBps / 100).toFixed(2)}%`],
        ['Route', quote.provider ?? (network.testHarness ? 'test router' : 'aggregator')],
      ]
      if (quote.platformFee) lines.push([`Platform fee (${(quote.platformFee.bps / 100).toFixed(2)}%)`, `${formatToken(quote.platformFee.amount, sellToken.decimals, 6)} ${sellToken.symbol}`])
      const valueUsdc = side === 'buy' ? usdcNumber(sellAmount, q.decimals) : usdcNumber(quote.buyAmount, q.decimals)

      return {
        ok: true,
        plan: {
          scope: 'swap',
          title: `Market ${side} ${base.symbol}`,
          lines,
          warnings: [],
          valueUsdc,
          builtAt: Date.now(),
          run: async (progress) => {
            const hashes: Hex[] = []
            if (quote.allowanceSpender) await ensureAllowance(sellToken, quote.allowanceSpender, sellAmount, progress, hashes)
            progress('Getting a firm quote…')
            let firm
            try {
              firm = await agg.quote(req)
            } catch (e) {
              throw new Error(e instanceof AggregatorError ? e.message : 'Could not get a firm quote.')
            }
            if (!firm?.transaction) throw new Error('No executable route right now.')
            // The user confirmed a specific price. Do not send something clearly worse.
            if (firm.buyAmount < (quote.buyAmount * 995n) / 1000n) throw new Error('The price moved against you after the confirmation. Nothing was sent; ask again to get a fresh quote.')
            progress('Confirm the swap in your wallet…')
            const receipt = await tx.send('Swap', { to: firm.transaction.to, data: firm.transaction.data, value: firm.transaction.value })
            hashes.push(receipt.transactionHash)
            void reportSwap(network.chainId, receipt.transactionHash)
            addLocalTrade({
              hash: receipt.transactionHash,
              chainId: network.chainId,
              time: Math.floor(Date.now() / 1000),
              side: side === 'buy' ? Side.BUY : Side.SELL,
              baseSymbol: base.symbol,
              sellAmount: formatToken(sellAmount, sellToken.decimals, 6),
              sellSymbol: sellToken.symbol,
              minBuyAmount: formatToken(firm.minBuyAmount, buyToken.decimals, 6),
              buySymbol: buyToken.symbol,
            })
            return { summary: `${side === 'buy' ? 'Bought' : 'Sold'} ${base.symbol}. Minimum received ${formatToken(firm.minBuyAmount, buyToken.decimals, 6)} ${buyToken.symbol}.`, hashes }
          },
        },
      }
    },
    [address, resolveToken, network, q, slippageBps, resolveAmount, ensureAllowance, tx],
  )

  // ---------- conditional orders ----------
  const ordersReady = useCallback(
    async (base: TokenInfo): Promise<{ orders: Address; price18: bigint } | { error: string }> => {
      if (!network.ordersAddress) return { error: `Orders are not available on ${network.label}: the order contract is not set up. Market buys and sells still work.` }
      if (!client) return { error: 'No connection to the network.' }
      const o = await readOracle(client, network.ordersAddress, base.address)
      if (o.status === 'no-feed') return { error: `${base.symbol} has no price feed on the order contract, so it cannot be used for orders or DCA. A market swap still works.` }
      if (o.status === 'unavailable') return { error: `The ${base.symbol} price is unavailable right now: ${o.message}` }
      if (o.status !== 'ok') return { error: 'The order contract is not set up.' }
      return { orders: network.ordersAddress, price18: o.price18 }
    },
    [network.ordersAddress, network.label, client],
  )

  const planOrder = useCallback(
    async (intent: Extract<Intent, { kind: 'limit' | 'stop_loss' | 'take_profit' | 'stop_limit' | 'trailing' | 'oco' }>): Promise<PlanResult> => {
      if (!address) return fail('Connect your wallet first.')
      const r = resolveToken(intent.token)
      if ('error' in r) return fail(r.error)
      const base = r.token
      const ready = await ordersReady(base)
      if ('error' in ready) return fail(ready.error)
      const { orders, price18: now } = ready

      const buy = intent.kind === 'limit' && intent.side === 'buy'
      const escrow = buy ? q : base
      const a = await resolveAmount(intent.amount, escrow)
      if ('error' in a) return fail(a.error)
      const amountIn = a.value

      const p = (s: string) => parsePrice18(s)
      let first = 0n
      let second = 0n
      let trailBps = 0
      let orderType: number = OrderType.LIMIT
      const priceLines: [string, string][] = []
      const warnings: string[] = []
      const px = (v: bigint) => `${formatPrice18(v)} ${q.symbol}`

      switch (intent.kind) {
        case 'limit': {
          const v = p(intent.price)
          if (!v) return fail('That price is not valid.')
          first = v
          orderType = OrderType.LIMIT
          priceLines.push([buy ? 'Buy at or below' : 'Sell at or above', px(v)])
          if (buy ? v >= now : v <= now) warnings.push(`The price is already ${buy ? 'at or above' : 'at or below'} the current ${px(now)}, so this can fill as soon as a keeper picks it up.`)
          break
        }
        case 'stop_loss': {
          const v = p(intent.price)
          if (!v) return fail('That price is not valid.')
          if (v >= now) return fail(`A stop-loss must be below the current price (${px(now)}).`)
          first = v
          orderType = OrderType.STOP_LOSS
          priceLines.push(['Sells when price falls to', px(v)])
          break
        }
        case 'take_profit': {
          const v = p(intent.price)
          if (!v) return fail('That price is not valid.')
          if (v <= now) return fail(`A take-profit must be above the current price (${px(now)}).`)
          first = v
          orderType = OrderType.TAKE_PROFIT
          priceLines.push(['Sells when price rises to', px(v)])
          break
        }
        case 'stop_limit': {
          const s = p(intent.stop)
          const l = p(intent.limit)
          if (!s || !l) return fail('Those prices are not valid.')
          if (s >= now) return fail(`The stop price must be below the current price (${px(now)}).`)
          if (l > s) return fail('The limit price must not be above the stop price.')
          first = s
          second = l
          orderType = OrderType.STOP_LIMIT
          priceLines.push(['Activates at', px(s)], ['Worst acceptable price', px(l)])
          warnings.push('A triggered stop-limit is not guaranteed to fill. If the market is worse than your limit it stays open until it expires.')
          break
        }
        case 'trailing': {
          trailBps = Math.round(Number(intent.trailPct) * 100)
          if (trailBps < 10 || trailBps > 5000) return fail('The trailing distance must be between 0.1% and 50%.')
          orderType = OrderType.TRAILING_STOP
          priceLines.push(['Trails the peak by', `${intent.trailPct}%`])
          warnings.push('A keeper must record new highs for the trailing stop to follow the market.')
          break
        }
        case 'oco': {
          const s = p(intent.stop)
          const t = p(intent.take)
          if (!s || !t) return fail('Those prices are not valid.')
          if (s >= now) return fail(`The stop-loss must be below the current price (${px(now)}).`)
          if (t <= now) return fail(`The take-profit must be above the current price (${px(now)}).`)
          first = s
          second = t
          orderType = OrderType.OCO
          priceLines.push(['Stop-loss at', px(s)], ['Take-profit at', px(t)])
          break
        }
      }

      // The contract rejects dust. Say so before the wallet does.
      const valueQuote = buy ? amountIn : quoteForBase(amountIn, now, base.decimals, q.decimals)
      if (client) {
        const min = await client.readContract({ address: orders, abi: ordersAbi, functionName: 'minOrderQuote' }).catch(() => 0n)
        if (min > 0n && valueQuote < min) return fail(`That is below the minimum order size of ${formatToken(min, q.decimals, 6)} ${q.symbol}.`)
      }

      const execPrice = intent.kind === 'stop_limit' ? second : intent.kind === 'oco' ? first : first || now
      const estimate = buy ? baseForQuote(amountIn, execPrice, base.decimals, q.decimals) : quoteForBase(amountIn, execPrice, base.decimals, q.decimals)
      const out = buy ? base : q
      const floor = applySlippage(estimate, slippageBps)
      const label = ORDER_TYPE_LABEL[orderType]
      const expiry = Math.floor(Date.now() / 1000) + expiryDays * 86400

      return {
        ok: true,
        plan: {
          scope: 'orders',
          title: `${label} ${buy ? 'buy' : 'sell'} ${base.symbol}`,
          lines: [
            ['Action', `${label} ${buy ? 'buy' : 'sell'} ${base.symbol}`],
            ['Escrowed now', `${formatToken(amountIn, escrow.decimals, 8)} ${escrow.symbol}`],
            ...priceLines,
            ['Current price', px(now)],
            ['Contract minimum output', `${formatToken(floor, out.decimals, 6)} ${out.symbol}`],
            ['Max slippage', `${(slippageBps / 100).toFixed(2)}%`],
            ['Expires', `${expiryDays} days`],
          ],
          warnings: [...warnings, 'Your funds are escrowed in the order contract until it fills, you cancel, or it expires. You can cancel at any time.'],
          valueUsdc: usdcNumber(valueQuote, q.decimals),
          builtAt: Date.now(),
          run: async (progress) => {
            const hashes: Hex[] = []
            await ensureAllowance(escrow, orders, amountIn, progress, hashes)
            progress('Confirm the order in your wallet…')
            const receipt = await tx.write('Create order', {
              address: orders,
              abi: ordersAbi,
              functionName: 'createOrder',
              args: [{ base: base.address, side: buy ? Side.BUY : Side.SELL, orderType, amountIn, triggerPrice: intent.kind === 'trailing' ? 0n : first, limitPrice: second, trailBps, maxSlippageBps: slippageBps, expiry }],
            })
            hashes.push(receipt.transactionHash)
            return { summary: `${label} order created. It runs when a keeper submits it, even with this tab closed.`, hashes }
          },
        },
      }
    },
    [address, resolveToken, ordersReady, q, resolveAmount, client, slippageBps, expiryDays, ensureAllowance, tx],
  )

  // ---------- DCA ----------
  const planDca = useCallback(
    async (intent: Extract<Intent, { kind: 'dca' }>): Promise<PlanResult> => {
      if (!address) return fail('Connect your wallet first.')
      const r = resolveToken(intent.token)
      if ('error' in r) return fail(r.error)
      const base = r.token
      const ready = await ordersReady(base)
      if ('error' in ready) return fail(ready.error)
      const perBuy = parseTokenAmount(intent.perBuy, q.decimals)
      if (!perBuy) return fail(`"${intent.perBuy}" is not a valid ${q.symbol} amount.`)
      const interval: number = FREQUENCIES.find((f) => f.id === intent.frequency)!.seconds
      const buys = buysForDuration(intent.days, interval)
      if (buys > 520) return fail(`That would be ${buys} buys. The most is 520; use a lower frequency or a shorter time.`)
      const total = perBuy * BigInt(buys)
      const balance = await balanceOf(q.address)
      if (total > balance) return fail(`The whole budget (${formatToken(total, q.decimals, 2)} ${q.symbol}) is escrowed now, but you have ${formatToken(balance, q.decimals, 2)}.`)
      const cap = intent.cap ? parsePrice18(intent.cap) : 0n
      if (intent.cap && !cap) return fail('The price cap is not valid.')

      return {
        ok: true,
        plan: {
          scope: 'dca',
          title: `DCA into ${base.symbol}`,
          lines: [
            ['Action', `Recurring buy of ${base.symbol}`],
            ['Per buy', `${formatToken(perBuy, q.decimals, 6)} ${q.symbol}`],
            ['Every', intent.frequency === 'hourly' ? 'hour' : intent.frequency === 'daily' ? 'day' : intent.frequency === 'weekly' ? 'week' : 'month (30 days)'],
            ['Number of buys', String(buys)],
            ['Budget escrowed now', `${formatToken(total, q.decimals, 6)} ${q.symbol}`],
            ['Price cap', cap ? `${formatPrice18(cap)} ${q.symbol}` : 'None'],
            ['Max slippage per buy', `${(slippageBps / 100).toFixed(2)}%`],
          ],
          warnings: ['The whole budget is escrowed in the order contract now. Each buy runs when a keeper submits it. You can pause, resume or cancel and withdraw the rest at any time.'],
          valueUsdc: usdcNumber(total, q.decimals),
          builtAt: Date.now(),
          run: async (progress) => {
            const hashes: Hex[] = []
            await ensureAllowance(q, ready.orders, total, progress, hashes)
            progress('Confirm the plan in your wallet…')
            const receipt = await tx.write('Create DCA plan', { address: ready.orders, abi: ordersAbi, functionName: 'createDca', args: [base.address, perBuy, buys, interval, 0, slippageBps, cap ?? 0n] })
            hashes.push(receipt.transactionHash)
            return { summary: `DCA plan created: ${buys} buys of ${formatToken(perBuy, q.decimals, 6)} ${q.symbol}.`, hashes }
          },
        },
      }
    },
    [address, resolveToken, ordersReady, q, balanceOf, slippageBps, ensureAllowance, tx],
  )

  // ---------- manage ----------
  const planManage = useCallback(
    (intent: Extract<Intent, { kind: 'cancel_order' | 'manage_dca' }>): PlanResult => {
      if (!address) return fail('Connect your wallet first.')
      if (!network.ordersAddress) return fail(`There is no order contract on ${network.label}.`)
      const orders = network.ordersAddress
      if (intent.kind === 'cancel_order') {
        const o = account.orders.find((x) => x.id === BigInt(intent.id))
        if (!o) return fail(`You have no order #${intent.id}. Type "orders" to list yours.`)
        if (o.status !== Status.OPEN) return fail(`Order #${intent.id} is not open any more.`)
        const t = tokens.find((x) => x.address.toLowerCase() === o.base.toLowerCase())
        return {
          ok: true,
          plan: {
            scope: 'manage',
            title: `Cancel order #${intent.id}`,
            lines: [
              ['Action', `Cancel ${ORDER_TYPE_LABEL[o.orderType]} ${o.side === Side.BUY ? 'buy' : 'sell'} ${t?.symbol ?? 'token'} #${intent.id}`],
              ['Refund', 'The escrowed amount returns to your wallet'],
            ],
            warnings: [],
            valueUsdc: 0,
            builtAt: Date.now(),
            run: async (progress) => {
              progress('Confirm in your wallet…')
              const r = await tx.write('Cancel order', { address: orders, abi: ordersAbi, functionName: 'cancelOrder', args: [BigInt(intent.id)] })
              return { summary: `Order #${intent.id} cancelled and refunded.`, hashes: [r.transactionHash] }
            },
          },
        }
      }
      const d = account.dcas.find((x) => x.id === BigInt(intent.id))
      if (!d) return fail(`You have no DCA plan #${intent.id}. Type "orders" to list yours.`)
      const live = d.status === DcaStatus.ACTIVE || d.status === DcaStatus.PAUSED
      if (!live) return fail(`DCA plan #${intent.id} has ended.`)
      if (intent.action === 'pause' && d.status !== DcaStatus.ACTIVE) return fail(`DCA plan #${intent.id} is not active.`)
      if (intent.action === 'resume' && d.status !== DcaStatus.PAUSED) return fail(`DCA plan #${intent.id} is not paused.`)
      const fn = intent.action === 'pause' ? 'pauseDca' : intent.action === 'resume' ? 'resumeDca' : 'cancelDca'
      return {
        ok: true,
        plan: {
          scope: 'manage',
          title: `${intent.action[0].toUpperCase()}${intent.action.slice(1)} DCA #${intent.id}`,
          lines: [
            ['Action', `${intent.action[0].toUpperCase()}${intent.action.slice(1)} DCA plan #${intent.id}`],
            ...(intent.action === 'cancel' ? ([['Refund', `${formatToken(d.budgetRemaining, q.decimals, 6)} ${q.symbol} returns to your wallet`]] as [string, string][]) : []),
          ],
          warnings: [],
          valueUsdc: 0,
          builtAt: Date.now(),
          run: async (progress) => {
            progress('Confirm in your wallet…')
            const r = await tx.write(`${intent.action} DCA`, { address: orders, abi: ordersAbi, functionName: fn, args: [BigInt(intent.id)] })
            return { summary: `DCA plan #${intent.id} ${intent.action === 'cancel' ? 'cancelled' : intent.action === 'pause' ? 'paused' : 'resumed'}.`, hashes: [r.transactionHash] }
          },
        },
      }
    },
    [address, network.ordersAddress, network.label, tokens, account.orders, account.dcas, q, tx],
  )

  const buildPlan = useCallback(
    async (intent: Intent): Promise<PlanResult> => {
      switch (intent.kind) {
        case 'swap':
          return planSwap(intent.side, intent.token, intent.amount)
        case 'limit':
        case 'stop_loss':
        case 'take_profit':
        case 'stop_limit':
        case 'trailing':
        case 'oco':
          return planOrder(intent)
        case 'dca':
          return planDca(intent)
        case 'cancel_order':
        case 'manage_dca':
          return planManage(intent)
        default:
          return fail('That is not an action.')
      }
    },
    [planSwap, planOrder, planDca, planManage],
  )

  /** Read-only commands: answered at once, nothing to confirm. */
  const answer = useCallback(
    async (intent: Intent): Promise<Answer> => {
      if (intent.kind === 'help') return { lines: HELP_LINES, text: 'Here is what I understand. I always read an action back and wait for your yes before anything is sent.' }
      if (intent.kind === 'balance') {
        if (!address) return { lines: [], text: 'Connect your wallet to see balances.' }
        const lines: [string, string][] = [['Account value', `${formatToken(account.total, q.decimals, 2)} ${q.symbol}`], ['Available', `${formatToken(account.available, q.decimals, 2)} ${q.symbol}`], ['In orders', `${formatToken(account.locked, q.decimals, 2)} ${q.symbol}`]]
        for (const r of account.rows) if (r.token.address !== q.address && r.available + r.locked > 0n) lines.push([r.token.symbol, formatToken(r.available + r.locked, r.token.decimals, 8)])
        return { lines }
      }
      if (intent.kind === 'orders') {
        if (!address) return { lines: [], text: 'Connect your wallet to see your orders.' }
        const sym = (a: string) => tokens.find((t) => t.address.toLowerCase() === a.toLowerCase())
        const open = account.orders.filter((o) => o.status === Status.OPEN)
        const plans = account.dcas.filter((d) => d.status === DcaStatus.ACTIVE || d.status === DcaStatus.PAUSED)
        const lines: [string, string][] = []
        for (const o of open) {
          const t = sym(o.base)
          const when = o.orderType === OrderType.OCO ? `stop ${formatPrice18(o.triggerPrice)} / take ${formatPrice18(o.limitPrice)}` : o.orderType === OrderType.TRAILING_STOP ? `trail ${o.trailBps / 100}%` : `trigger ${formatPrice18(o.triggerPrice)}`
          lines.push([`Order #${o.id}`, `${ORDER_TYPE_LABEL[o.orderType]} ${o.side === Side.BUY ? 'buy' : 'sell'} ${t?.symbol ?? '?'}, ${when}`])
        }
        for (const d of plans) lines.push([`DCA #${d.id}`, `${sym(d.base)?.symbol ?? '?'}, ${formatToken(d.amountPerBuy, q.decimals, 4)} ${q.symbol} each, ${d.status === DcaStatus.PAUSED ? 'paused' : 'active'}, ${formatToken(d.budgetRemaining, q.decimals, 4)} left`])
        return lines.length ? { lines } : { lines: [], text: 'You have no open orders or DCA plans.' }
      }
      if (intent.kind === 'price') {
        const r = resolveToken(intent.token)
        if ('error' in r) return { lines: [], text: r.error }
        const lines: [string, string][] = []
        if (client && network.ordersAddress) {
          const o = await readOracle(client, network.ordersAddress, r.token.address)
          if (o.status === 'ok') lines.push(['Oracle price', `${formatPrice18(o.price18)} ${q.symbol}`])
        }
        const agg = getAggregator(network)
        if (!agg.unavailableReason() && address) {
          try {
            const sellAmount = 10n * 10n ** BigInt(q.decimals)
            const quote = await agg.price({ chainId: network.chainId, sellToken: q.address, buyToken: r.token.address, sellAmount, taker: address, slippageBps })
            if (quote && quote.buyAmount > 0n) lines.push([`Swap price (10 ${q.symbol})`, `${formatPrice18((quote.sellAmount * 10n ** 18n * 10n ** BigInt(r.token.decimals)) / (quote.buyAmount * 10n ** BigInt(q.decimals)))} ${q.symbol}`])
          } catch {
            /* the quote service is optional here */
          }
        }
        return lines.length ? { lines, text: `${r.token.symbol} / ${q.symbol}` } : { lines: [], text: `I could not read a price for ${r.token.symbol} right now.` }
      }
      return { lines: [] }
    },
    [address, account, q, network, tokens, client, resolveToken, slippageBps],
  )

  return { buildPlan, answer, connected: Boolean(address), busy: tx.busy }
}
