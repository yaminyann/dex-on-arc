import { useState, type ReactNode } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { ExternalLink, ShieldAlert } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { erc20Abi, isAddress, parseUnits, type Address } from 'viem'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '@/onchain-facts'
import type { NetworkConfig } from '@/trading/networks'
import { ordersAbi } from '@/trading/ordersAbi'
import { useTx } from '@/trading/tx'
import { formatToken } from '@/trading/math'
import { fmtDateTime, fmtDuration, shortAddr } from '@/trading/format'
import { useAdminConfig, useContractState, useOperatorHealth, type ContractState } from '@/trading/admin'
import { useNowSeconds } from '@/trading/hooks'
import { lookupToken } from './OrderTables'
import { Badge, Button, Empty, Field, Notice, Panel, Row, Skeleton } from './ui'

const TOKEN_KEY = 'arc-terminal-admin-token'

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Panel className="p-4">
      <h2 className="text-lg">{title}</h2>
      {hint && <p className="mb-3 mt-0.5 text-xs text-mute">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </Panel>
  )
}

function AddressLink({ network, address, label }: { network: NetworkConfig; address: string; label?: string }) {
  return (
    <a href={buildAddressExplorerUrl(network.chainId, address)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2" title={address}>
      {label ? `${label} ${shortAddr(address)}` : shortAddr(address)}
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}

/** Owner page: every control the contract gives the administrator, plus the money and health picture. */
export function Admin({ network }: { network: NetworkConfig }) {
  const { address } = useAccount()
  const state = useContractState(network)
  const tx = useTx(network)
  const qc = useQueryClient()
  // Kept for this tab only; sent to your own backend as a bearer token and nowhere else.
  const [adminToken, setAdminTokenState] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '')
  const setAdminToken = (t: string) => {
    sessionStorage.setItem(TOKEN_KEY, t)
    setAdminTokenState(t)
  }

  if (!network.ordersAddress) {
    return (
      <Panel>
        <Empty title="No order contract on this network">The admin page controls the order contract. Set its address first.</Empty>
      </Panel>
    )
  }
  if (state.isLoading || !state.data) return <Skeleton className="h-64" />

  const s = state.data
  const me = address?.toLowerCase()
  const isOwner = me === s.owner.toLowerCase()
  const isPendingOwner = Boolean(s.pendingOwner && me === s.pendingOwner.toLowerCase())

  const run = async (label: string, functionName: string, args: readonly unknown[]) => {
    try {
      await tx.write(label, { address: network.ordersAddress!, abi: ordersAbi, functionName, args })
      void qc.invalidateQueries({ queryKey: ['admin-state'] })
      void qc.invalidateQueries({ queryKey: ['admin-config'] })
    } catch {
      /* the transaction hook already showed the error */
    }
  }

  if (!isOwner && !isPendingOwner) {
    return (
      <div className="mx-auto max-w-xl space-y-4 pt-6">
        <Panel className="p-8 text-center">
          <ShieldAlert className="mx-auto h-6 w-6 text-mute" />
          <h1 className="mt-3 text-2xl">Owner wallet required</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-mute">
            Connect the contract owner ({shortAddr(s.owner)}) to change settings. Everything here is enforced by the contract, so no other wallet can change anything.
          </p>
        </Panel>
      </div>
    )
  }

  if (!isOwner) {
    return (
      <div className="mx-auto max-w-xl space-y-4 pt-6">
        <Section title="Accept ownership" hint={`${shortAddr(s.owner)} offered you ownership of this contract. It only takes effect when you accept.`}>
          <Button variant="primary" disabled={tx.busy} onClick={() => void run('Accept ownership', 'acceptOwnership', [])}>
            Accept ownership
          </Button>
        </Section>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-3xl">Admin</h1>
        <Badge tone={s.paused ? 'down' : 'up'}>{s.paused ? 'Paused' : 'Live'}</Badge>
        <span className="text-xs text-mute">
          Contract <AddressLink network={network} address={network.ordersAddress} /> · owner <AddressLink network={network} address={s.owner} />
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <StatusSection network={network} s={s} busy={tx.busy} run={run} />
        <FeesSection network={network} s={s} busy={tx.busy} run={run} token={adminToken} />
      </div>
      <ConfigSection network={network} s={s} busy={tx.busy} run={run} />
      <BackendSection network={network} token={adminToken} setToken={setAdminToken} />
    </div>
  )
}

type Run = (label: string, fn: string, args: readonly unknown[]) => Promise<void>
interface SectionProps {
  network: NetworkConfig
  s: ContractState
  busy: boolean
  run: Run
}

function StatusSection({ network, s, busy, run }: SectionProps) {
  const [minimum, setMinimum] = useState('')
  const [newOwner, setNewOwner] = useState('')
  const min = Number(minimum)
  const minOk = minimum !== '' && Number.isFinite(min) && min >= 0 && min <= 10_000
  const q = network.quote
  return (
    <Section title="Contract controls" hint="Pause stops new escrow and executions. Cancels, refunds and expiries always keep working, so pausing never traps funds.">
      <div className="mb-3 divide-y divide-line rounded-lg border border-line px-3">
        <Row label="Orders created" value={(s.nextOrderId - 1n).toString()} />
        <Row label="DCA plans created" value={(s.nextDcaId - 1n).toString()} />
        <Row label="Config change delay" value={fmtDuration(s.configDelay)} />
        <Row label="Minimum order size" value={s.minOrderQuote === 0n ? 'None' : `${formatToken(s.minOrderQuote, q.decimals, 6)} ${q.symbol}`} />
      </div>
      <div className="space-y-4">
        <Button variant={s.paused ? 'primary' : 'danger'} className="w-full" disabled={busy} onClick={() => void run(s.paused ? 'Resume contract' : 'Pause contract', s.paused ? 'unpause' : 'pause', [])}>
          {s.paused ? 'Resume trading' : 'Pause trading (emergency)'}
        </Button>

        <div>
          <Field label={`Minimum order size (${q.symbol}, 0 to 10000)`} placeholder="0.10" value={minimum} onChange={(e) => setMinimum(e.target.value)} right={q.symbol} error={minimum !== '' && !minOk ? 'Enter 0 to 10000' : null} />
          <Button variant="ghost" className="mt-2 w-full" disabled={busy || !minOk} onClick={() => void run('Set minimum order', 'setMinOrderQuote', [parseUnits(minimum, q.decimals)])}>
            Set minimum order size
          </Button>
          <p className="mt-1 text-[11px] text-mute">Applies to new orders only and never touches escrow, so it takes effect at once.</p>
        </div>

        <div>
          <Field label="Transfer ownership (two steps)" placeholder="0x... new owner or multisig" value={newOwner} onChange={(e) => setNewOwner(e.target.value.trim())} error={newOwner !== '' && !isAddress(newOwner) ? 'Not an address' : null} />
          <Button variant="ghost" className="mt-2 w-full" disabled={busy || !isAddress(newOwner)} onClick={() => void run('Offer ownership', 'transferOwnership', [newOwner])}>
            Offer ownership
          </Button>
          <p className="mt-1 text-[11px] text-mute">
            {s.pendingOwner ? `Pending: ${shortAddr(s.pendingOwner)} must accept before anything changes.` : 'The new owner must accept from their wallet; until then you stay in control. Renouncing is disabled.'}
          </p>
        </div>
      </div>
    </Section>
  )
}

function FeesSection({ s, busy, run, token }: SectionProps & { token: string }) {
  const [bps, setBps] = useState('')
  const op = useOperatorHealth(token)
  const next = Number(bps)
  const bpsOk = bps !== '' && Number.isInteger(next) && next >= 0 && next <= s.keeperFeeBps
  const fee = op.data?.platformFee
  return (
    <Section title="Fees" hint="Two separate fees. Neither one can be raised later without a new deployment (keeper fee) or a redeploy of the backend (swap fee).">
      <div className="divide-y divide-line rounded-lg border border-line px-3">
        <Row label="Keeper fee on orders and DCA" value={`${(s.keeperFeeBps / 100).toFixed(2)}% of output (cap 0.10%)`} />
        <Row label="Platform fee on market swaps" value={fee ? `${(fee.bps / 100).toFixed(2)}% of the sell amount` : 'Off'} />
        {fee?.recipient && <Row label="Swap fee recipient" value={shortAddr(fee.recipient)} />}
      </div>
      {op.data?.platformFeeProblem && (
        <div className="mt-2">
          <Notice tone="warn">{op.data.platformFeeProblem}</Notice>
        </div>
      )}
      {op.isError && !fee && (
        <div className="mt-2">
          <Notice>Enter the admin token under Backend status to see the swap fee recipient.</Notice>
        </div>
      )}
      <ul className="mt-3 space-y-1.5 text-[11px] text-mute">
        <li>
          <span className="text-ink">Keeper fee</span> is paid by the contract to whoever submits an execution. Run your own keeper and that wallet earns it. The owner can only lower it.
        </li>
        <li>
          <span className="text-ink">Swap fee</span> is taken by the aggregator inside the swap transaction and sent to the recipient. Change it with PLATFORM_FEE_BPS and PLATFORM_FEE_RECIPIENT on the backend (max 1%). It does not apply to orders, or to testnet routers.
        </li>
      </ul>

      <div className="mt-4">
        <Field label={`Lower keeper fee (bps, 0 to ${s.keeperFeeBps})`} placeholder={String(s.keeperFeeBps)} value={bps} onChange={(e) => setBps(e.target.value)} right="bps" error={bps !== '' && !bpsOk ? `Whole number from 0 to ${s.keeperFeeBps}` : null} />
        <Button variant="ghost" className="mt-2 w-full" disabled={busy || !bpsOk || next === s.keeperFeeBps} onClick={() => void run('Lower keeper fee', 'setKeeperFeeBps', [next])}>
          Lower keeper fee
        </Button>
        <p className="mt-1 text-[11px] text-mute">Lowering is permanent: the contract rejects any increase.</p>
      </div>
    </Section>
  )
}

function ConfigSection({ network, s, busy, run }: SectionProps) {
  const cfg = useAdminConfig(network)
  const now = useNowSeconds(5_000)
  const [tokenAddr, setTokenAddr] = useState('')
  const [feed, setFeed] = useState('')
  const [stale, setStale] = useState('90000')
  const [target, setTarget] = useState('')
  const staleN = Number(stale)
  const tokenOk = isAddress(tokenAddr) && isAddress(feed) && Number.isInteger(staleN) && staleN >= 60 && staleN <= 172_800
  const delay = fmtDuration(s.configDelay)

  const data = cfg.data
  return (
    <Section title="Tokens, routers and timelocked changes" hint={`Adding or changing a token feed or a swap router is queued, then can be applied after ${delay}. Disabling is instant. Every queued change is public.`}>
      {cfg.isLoading ? (
        <Skeleton className="h-24" />
      ) : data === null ? (
        <Notice tone="warn" title="Owner history needs the indexer">
          Set INDEXER_ENABLED=true on the backend to list tokens, routers and queued changes here. You can still queue changes below.
        </Notice>
      ) : cfg.isError ? (
        <Notice tone="error">Could not load the owner history.</Notice>
      ) : (
        data && (
          <div className="space-y-5">
            <div>
              <h3 className="mb-1 text-xs font-medium text-mute">Queued changes</h3>
              {data.pending.length === 0 ? (
                <p className="text-xs text-mute">Nothing queued.</p>
              ) : (
                <ul className="space-y-2">
                  {data.pending.map((p) => {
                    const ready = now >= p.eta
                    return (
                      <li key={p.changeId} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2.5 text-xs">
                        <Badge tone={p.isToken ? 'accent' : 'warn'}>{p.isToken ? 'Token feed' : 'Swap router'}</Badge>
                        <span className="num">
                          <AddressLink network={network} address={p.subject} label={p.isToken ? lookupToken(network, p.subject)?.symbol : undefined} />
                          {p.isToken ? ` feed ${p.feed === '0x0000000000000000000000000000000000000000' ? 'off' : shortAddr(p.feed)}` : p.allowed ? ' allow' : ' revoke'}
                        </span>
                        <span className="ml-auto text-mute">{ready ? 'Ready to apply' : `Ready in ${fmtDuration(p.eta - now)}`}</span>
                        <Button variant="primary" className="min-h-[32px] px-3 text-xs" disabled={busy || !ready} onClick={() => void run('Apply change', 'applyConfig', [p.changeId])}>
                          Apply
                        </Button>
                        <Button variant="danger" className="min-h-[32px] px-3 text-xs" disabled={busy} onClick={() => void run('Cancel change', 'cancelConfig', [p.changeId])}>
                          Cancel
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-medium text-mute">Tokens with a price feed</h3>
                {data.tokens.length === 0 ? (
                  <p className="text-xs text-mute">None yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.tokens.map((t) => (
                      <li key={t.token} className="flex items-center gap-2 text-xs">
                        <AddressLink network={network} address={t.token} label={lookupToken(network, t.token)?.symbol} />
                        <Badge tone={t.enabled ? 'up' : 'mute'}>{t.enabled ? 'Enabled' : 'Disabled'}</Badge>
                        <span className="text-mute">{t.enabled ? `stale after ${fmtDuration(t.maxStaleness)}` : ''}</span>
                        {t.enabled && (
                          <Button variant="danger" className="ml-auto min-h-[28px] px-2 text-[11px]" disabled={busy} onClick={() => void run('Disable token', 'disableToken', [t.token])}>
                            Disable now
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="mb-1 text-xs font-medium text-mute">Allowed swap routers</h3>
                {data.targets.filter((t) => t.allowed).length === 0 ? (
                  <p className="text-xs text-mute">None allowed.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.targets
                      .filter((t) => t.allowed)
                      .map((t) => (
                        <li key={t.target} className="flex items-center gap-2 text-xs">
                          <AddressLink network={network} address={t.target} />
                          <Badge tone="up">Allowed</Badge>
                          <Button variant="danger" className="ml-auto min-h-[28px] px-2 text-[11px]" disabled={busy} onClick={() => void run('Disable router', 'disableSwapTarget', [t.target])}>
                            Disable now
                          </Button>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )
      )}

      <div className="mt-5 grid gap-5 border-t border-line pt-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-mute">Queue a token feed</h3>
          <Field label="Token address" placeholder="0x..." value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value.trim())} error={tokenAddr && !isAddress(tokenAddr) ? 'Not an address' : null} />
          <Field label="Chainlink-style feed address" placeholder="0x..." value={feed} onChange={(e) => setFeed(e.target.value.trim())} error={feed && !isAddress(feed) ? 'Not an address' : null} />
          <Field label="Max staleness (60 to 172800 s)" value={stale} onChange={(e) => setStale(e.target.value)} right="seconds" error={stale !== '' && !(staleN >= 60 && staleN <= 172_800) ? 'Between 60 and 172800' : null} />
          <Button variant="primary" className="w-full" disabled={busy || !tokenOk} onClick={() => void run('Queue token feed', 'queueTokenConfig', [tokenAddr, feed, staleN])}>
            Queue token feed
          </Button>
          <p className="text-[11px] text-mute">Feeds have a heartbeat (Chainlink: 24 h on Arc). Set staleness a little above it.</p>
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-mute">Queue a swap router</h3>
          <Field label="Router contract address" placeholder="0x..." value={target} onChange={(e) => setTarget(e.target.value.trim())} error={target && !isAddress(target) ? 'Not an address' : null} />
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" disabled={busy || !isAddress(target)} onClick={() => void run('Queue router allow', 'queueSwapTarget', [target, true])}>
              Queue allow
            </Button>
            <Button variant="ghost" className="flex-1" disabled={busy || !isAddress(target)} onClick={() => void run('Queue router revoke', 'queueSwapTarget', [target, false])}>
              Queue revoke
            </Button>
          </div>
          <Notice tone="warn">Only allow audited aggregator routers. Never allow a token or any contract that can call into the order contract.</Notice>
        </div>
      </div>

      {data && data.events.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="mb-2 text-xs font-medium text-mute">Recent owner actions</h3>
          <ul className="max-h-56 space-y-1 overflow-y-auto text-xs thin-scroll">
            {data.events.slice(0, 40).map((e, i) => (
              <li key={`${e.txHash}-${e.name}-${i}`} className="flex items-center gap-2">
                <span className="num w-36 shrink-0 text-mute">{fmtDateTime(e.blockTime)}</span>
                <span>{e.name}</span>
                <a href={buildTxExplorerUrl(network.chainId, e.txHash)} target="_blank" rel="noopener noreferrer" className="ml-auto text-mute underline" aria-label="Open transaction">
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

function BackendSection({ network, token, setToken }: { network: NetworkConfig; token: string; setToken: (t: string) => void }) {
  const [draft, setDraft] = useState(token)
  const op = useOperatorHealth(token)
  const h = op.data
  const keeperAddr = h?.keeper?.keeperAddress ?? null
  const now = useNowSeconds(5_000)

  return (
    <Section title="Backend status" hint="Keeper, quote providers and indexer. Detailed status needs the ADMIN_TOKEN; it is kept for this tab only and never leaves your browser except to your own backend.">
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setToken(draft.trim())
        }}
      >
        <input
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Admin token"
          aria-label="Admin token"
          className="num min-h-[44px] min-w-0 flex-1 border border-line bg-panel px-3 text-sm placeholder:text-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        />
        <Button variant="ghost" type="submit">
          Load
        </Button>
      </form>

      {op.isError ? (
        <Notice tone="warn" title="Backend not reachable">Start the API (and set VITE proxy or the web service) and try again.</Notice>
      ) : !h ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div>
            <h3 className="mb-1 text-xs font-medium text-mute">Keeper</h3>
            <div className="divide-y divide-line rounded-lg border border-line px-3">
              <Row label="State" value={<Badge tone={h.keeper?.running ? 'up' : 'down'}>{h.keeper?.running ? 'Running' : 'Stopped'}</Badge>} />
              <Row label="Role" value={h.keeper?.role ?? '-'} />
              <Row label="Wallet" value={keeperAddr ? <AddressLink network={network} address={keeperAddr} /> : 'Operator only'} />
              <Row label="Executions" value={String(h.keeper?.executed ?? 0)} />
              <Row label="Open orders / DCA" value={`${h.keeper?.openOrders ?? '-'} / ${h.keeper?.openDcas ?? '-'}`} />
              <Row label="Last tick" value={h.keeper?.lastTick ? `${Math.max(0, now - Math.floor(h.keeper.lastTick / 1000))}s ago` : '-'} />
            </div>
            {h.keeper?.lastError && <p className="mt-1 text-[11px] text-warn">{h.keeper.lastError}</p>}
            {keeperAddr && <KeeperBalance network={network} address={keeperAddr as Address} />}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium text-mute">Quote providers</h3>
            <div className="divide-y divide-line rounded-lg border border-line px-3">
              {(h.gateway?.providers ?? []).map((p) => (
                <Row key={p.id} label={p.id} value={<Badge tone={!p.configured ? 'mute' : p.breaker === 'open' ? 'down' : 'up'}>{!p.configured ? 'No key' : p.breaker === 'open' ? 'Breaker open' : 'OK'}</Badge>} />
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium text-mute">Indexer</h3>
            <div className="divide-y divide-line rounded-lg border border-line px-3">
              <Row label="State" value={<Badge tone={h.indexer?.running ? 'up' : 'mute'}>{h.indexer?.running ? 'Running' : 'Off'}</Badge>} />
              <Row label="Lag (blocks)" value={h.indexer?.lagBlocks === null || h.indexer?.lagBlocks === undefined ? '-' : String(h.indexer.lagBlocks)} />
            </div>
            {h.indexer?.lastError && <p className="mt-1 text-[11px] text-warn">{h.indexer.lastError}</p>}
          </div>
        </div>
      )}
    </Section>
  )
}

function KeeperBalance({ network, address }: { network: NetworkConfig; address: Address }) {
  const bal = useKeeperBalance(network, address)
  const low = bal !== null && bal < 1_000_000n
  return (
    <p className={`mt-1 text-[11px] ${low ? 'text-warn' : 'text-mute'}`}>
      Gas balance {bal === null ? '-' : `${formatToken(bal, network.quote.decimals, 4)} ${network.quote.symbol}`}
      {low ? ' - low, top it up so executions keep running' : ''}
    </p>
  )
}


function useKeeperBalance(network: NetworkConfig, address: Address): bigint | null {
  const client = usePublicClient({ chainId: network.chainId })
  const q = useQuery({
    queryKey: ['keeper-balance', network.key, address],
    enabled: Boolean(client),
    refetchInterval: 20_000,
    queryFn: () => client!.readContract({ address: network.quote.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  })
  return q.data ?? null
}
