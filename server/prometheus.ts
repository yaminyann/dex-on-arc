/** Renders the in-memory counters in Prometheus text exposition format (version 0.0.4). */

export interface PromSnapshot {
  uptimeSeconds: number
  http: Record<string, number>
  keeper: Record<string, number>
  providers: { id: string; configured: boolean; breaker: string; consecutiveFailures: number }[]
  priceCacheEntries: number
  nowMs: number
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

export function renderPrometheus(s: PromSnapshot): string {
  const out: string[] = []
  const metric = (name: string, type: 'counter' | 'gauge', help: string, samples: [string, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    for (const [labels, value] of samples) out.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`)
  }

  metric('arc_uptime_seconds', 'gauge', 'Process uptime.', [['', s.uptimeSeconds]])
  metric('arc_http_requests_total', 'counter', 'HTTP requests handled.', [['', s.http.requests ?? 0]])
  metric('arc_http_rate_limited_total', 'counter', 'Requests rejected by the per-client limiter.', [['', s.http.rateLimited ?? 0]])
  metric('arc_price_cache_total', 'counter', 'Price cache lookups.', [
    ['{result="hit"}', s.http.cacheHits ?? 0],
    ['{result="miss"}', s.http.cacheMisses ?? 0],
  ])
  metric('arc_upstream_errors_total', 'counter', 'Failed upstream quote requests.', [['', s.http.upstreamErrors ?? 0]])
  metric('arc_price_cache_entries', 'gauge', 'Entries in the price cache.', [['', s.priceCacheEntries]])

  const k = s.keeper
  metric('arc_keeper_ticks_total', 'counter', 'Keeper loop iterations.', [['', k.ticks ?? 0]])
  metric('arc_keeper_last_tick_ms', 'gauge', 'Duration of the last keeper tick.', [['', k.lastTickMs ?? 0]])
  metric('arc_keeper_last_ok_tick_age_seconds', 'gauge', 'Seconds since the last tick that completed without error (-1 if none).', [
    ['', k.lastOkTickAt ? Math.max(0, Math.round((s.nowMs - k.lastOkTickAt) / 1000)) : -1],
  ])
  metric('arc_keeper_consecutive_tick_errors', 'gauge', 'Ticks in a row that threw.', [['', k.consecutiveTickErrors ?? 0]])
  metric('arc_keeper_open_items', 'gauge', 'Open items tracked by this shard.', [
    ['{kind="order"}', k.openOrders ?? 0],
    ['{kind="dca"}', k.openDcas ?? 0],
  ])
  metric('arc_keeper_actions_total', 'counter', 'Keeper actions by result.', [
    ['{result="executed"}', k.executed ?? 0],
    ['{result="failed"}', k.failedExecutions ?? 0],
    ['{result="maintenance"}', k.maintenanceCalls ?? 0],
    ['{result="skipped_backoff"}', k.skippedBackoff ?? 0],
    ['{result="skipped_unprofitable"}', k.skippedUnprofitable ?? 0],
  ])
  metric('arc_keeper_tx_total', 'counter', 'Transactions submitted and failed.', [
    ['{result="sent"}', k.txSent ?? 0],
    ['{result="failed"}', k.txFailed ?? 0],
  ])
  metric('arc_keeper_provider_fallbacks_total', 'counter', 'Executions that used a lower-ranked provider because the best one failed simulation.', [['', k.providerFallbacks ?? 0]])
  metric('arc_keeper_batches_total', 'counter', 'executeMany transactions prepared.', [['', k.batches ?? 0]])
  metric('arc_keeper_event_wakeups_total', 'counter', 'Idle sleeps ended early by an onchain event.', [['', k.wakeups ?? 0]])
  metric('arc_keeper_standby_waiting', 'gauge', 'Executable items a standby keeper is waiting to take over.', [['', k.standbyWaiting ?? 0]])
  metric('arc_keeper_rpc_multicalls_total', 'counter', 'Batched read requests.', [['', k.rpcMulticalls ?? 0]])
  metric('arc_keeper_balance_usdc', 'gauge', 'Keeper wallet balance in whole USDC (-1 unknown).', [['', k.balanceUsdc ?? -1]])

  metric(
    'arc_gateway_provider_up',
    'gauge',
    '1 when the provider is configured and its breaker is closed.',
    s.providers.map((p) => [`{provider="${esc(p.id)}"}`, p.configured && p.breaker === 'closed' ? 1 : 0] as [string, number]),
  )
  metric(
    'arc_gateway_provider_consecutive_failures',
    'gauge',
    'Consecutive failed requests per provider.',
    s.providers.map((p) => [`{provider="${esc(p.id)}"}`, p.consecutiveFailures] as [string, number]),
  )
  return out.join('\n') + '\n'
}
