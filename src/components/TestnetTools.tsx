import { useState } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { erc20Abi, parseUnits } from 'viem'
import { ChevronDown, FlaskConical } from 'lucide-react'
import type { NetworkConfig, TokenInfo } from '@/trading/networks'
import { useTx } from '@/trading/tx'
import { formatToken } from '@/trading/math'
import { Button, Notice, Panel } from './ui'

const feedAbi = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
  { type: 'function', name: 'setPrice', stateMutability: 'nonpayable', inputs: [{ name: 'price', type: 'int256' }], outputs: [] },
  { type: 'function', name: 'refresh', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

const faucetAbi = [{ type: 'function', name: 'faucet', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const

/** Testnet-only controls: get test tokens and move the public test price so orders can be triggered. */
export function TestnetTools({ network, base }: { network: NetworkConfig; base: TokenInfo | undefined }) {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: network.chainId })
  const tx = useTx(network)
  const qc = useQueryClient()
  const [price, setPrice] = useState('')
  const [open, setOpen] = useState(false)

  const feed = base?.testFeed
  const state = useQuery({
    queryKey: ['test-feed', feed],
    enabled: Boolean(client && feed),
    refetchInterval: 8_000,
    queryFn: async () => {
      const [, answer, , updatedAt] = await client!.readContract({ address: feed!, abi: feedAbi, functionName: 'latestRoundData' })
      const routerUsdc = network.testHarness
        ? await client!.readContract({ address: network.quote.address, abi: erc20Abi, functionName: 'balanceOf', args: [network.testHarness.router] })
        : 0n
      return { answer, updatedAt: Number(updatedAt), routerUsdc }
    },
  })

  if (!network.testHarness || !base?.isTest || !feed) return null

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['test-feed'] })
    void qc.invalidateQueries({ queryKey: ['oracle'] })
    void qc.invalidateQueries({ queryKey: ['balances'] })
    void qc.invalidateQueries({ queryKey: ['orders'] })
  }
  const run = async (label: string, p: Parameters<typeof tx.write>[1]) => {
    try {
      await tx.write(label, p)
      refresh()
    } catch {
      /* the transaction hook already reported the error */
    }
  }

  const current = state.data ? Number(state.data.answer) / 1e8 : null
  const setTo = (usd: number) => {
    if (!(usd > 0)) return
    void run(`Set ${base.symbol} test price`, { address: feed, abi: feedAbi, functionName: 'setPrice', args: [parseUnits(usd.toFixed(8), 8)] })
  }

  return (
    <Panel>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <FlaskConical className="h-4 w-4 text-warn" />
        <span className="font-display text-sm font-semibold">Testnet tools</span>
        <span className="num ml-auto text-xs text-mute">{current !== null ? `${base.symbol} $${current.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}</span>
        <ChevronDown className={`h-4 w-4 text-mute transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
      <div className="space-y-3 border-t border-line p-4 text-xs">
        <p className="text-mute">
          {base.symbol} follows a public test price. Move it to trigger your stop, limit and trailing orders; a keeper then fills them through the test router.
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-mute">Test price</span>
          <span className="num font-medium">{current !== null ? `$${current.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : '-'}</span>
        </div>
        <div className="flex gap-1.5">
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="New price in USD"
            aria-label="New test price in USD"
            className="num min-h-[40px] min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent"
          />
          <Button variant="ghost" className="min-h-[40px] border border-line" disabled={!address || tx.busy || !(Number(price) > 0)} onClick={() => setTo(Number(price))}>
            Set
          </Button>
        </div>
        <div className="flex gap-1.5">
          {[-10, -5, 5, 10].map((pct) => (
            <Button key={pct} variant="ghost" className="min-h-[36px] flex-1 border border-line px-1 text-xs" disabled={!address || tx.busy || current === null} onClick={() => current !== null && setTo(current * (1 + pct / 100))}>
              {pct > 0 ? '+' : ''}
              {pct}%
            </Button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            className="min-h-[40px] flex-1 border border-line"
            disabled={!address || tx.busy}
            onClick={() => void run(`Get test ${base.symbol}`, { address: base.address, abi: faucetAbi, functionName: 'faucet', args: [] })}
          >
            Get {base.faucetAmount} {base.symbol}
          </Button>
          <Button variant="ghost" className="min-h-[40px] border border-line" disabled={!address || tx.busy} onClick={() => void run('Refresh feed', { address: feed, abi: feedAbi, functionName: 'refresh', args: [] })}>
            Refresh feed
          </Button>
        </div>
        <div className="flex items-center justify-between text-mute">
          <span>Router USDC liquidity</span>
          <span className="num">{state.data ? formatToken(state.data.routerUsdc, network.quote.decimals, 2) : '-'} USDC</span>
        </div>
        {state.data && state.data.routerUsdc < 5_000_000n && (
          <Notice tone="warn">The test router is low on USDC, so large sells may fail. Send test USDC to {network.testHarness.router.slice(0, 6)}...{network.testHarness.router.slice(-4)} to refill it.</Notice>
        )}
      </div>
      )}
    </Panel>
  )
}
