/**
 * What the Agent Station is allowed to do, granted once and kept on this device.
 *
 * The grant never touches keys: the wallet still signs every transaction. It decides whether the agent
 * may prepare actions at all, which kinds, how large, and whether it must read each command back and wait
 * for a yes first (`confirm`, the default) or may run commands that fit the limits right after reading
 * them back (`auto`).
 */
export type AgentMode = 'confirm' | 'auto'
export type AgentScope = 'swap' | 'orders' | 'dca' | 'manage'

export interface AgentPermission {
  granted: boolean
  grantedAt: number
  /** Milliseconds since epoch, or null for "until I revoke it". */
  expiresAt: number | null
  mode: AgentMode
  /** Largest single command, in USDC. */
  maxPerCommand: number
  /** Total the agent may move per calendar day, in USDC. */
  dailyLimit: number
  scopes: Record<AgentScope, boolean>
}

export const DEFAULT_AGENT: AgentPermission = {
  granted: false,
  grantedAt: 0,
  expiresAt: null,
  mode: 'confirm',
  maxPerCommand: 100,
  dailyLimit: 500,
  scopes: { swap: true, orders: true, dca: true, manage: true },
}

export const SCOPE_LABEL: Record<AgentScope, string> = {
  swap: 'Market swaps',
  orders: 'Limit, stop-loss, take-profit, trailing, OCO',
  dca: 'DCA plans',
  manage: 'Cancel, pause and resume',
}

export const DURATIONS = [
  { id: 'session', label: 'This tab only', ms: -1 },
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '24h', label: '24 hours', ms: 86_400_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { id: 'forever', label: 'Until I revoke it', ms: 0 },
] as const

/** True while the grant exists and has not expired. */
export function isGrantActive(p: AgentPermission, now: number): boolean {
  if (!p.granted) return false
  return p.expiresAt === null || now < p.expiresAt
}

export function sanitizePermission(raw: unknown): AgentPermission {
  const r = (raw ?? {}) as Partial<AgentPermission>
  const num = (v: unknown, fallback: number, lo: number, hi: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
  }
  const scopes = (r.scopes ?? {}) as Partial<Record<AgentScope, boolean>>
  return {
    granted: r.granted === true,
    grantedAt: num(r.grantedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    expiresAt: r.expiresAt === null || r.expiresAt === undefined ? null : num(r.expiresAt, 0, 0, Number.MAX_SAFE_INTEGER),
    mode: r.mode === 'auto' ? 'auto' : 'confirm',
    maxPerCommand: num(r.maxPerCommand, DEFAULT_AGENT.maxPerCommand, 0, 1_000_000),
    dailyLimit: num(r.dailyLimit, DEFAULT_AGENT.dailyLimit, 0, 10_000_000),
    scopes: {
      swap: scopes.swap !== false,
      orders: scopes.orders !== false,
      dca: scopes.dca !== false,
      manage: scopes.manage !== false,
    },
  }
}

export type GateResult = { allowed: true; autoRun: boolean } | { allowed: false; reason: string }

/**
 * Decides whether a command may be prepared and whether it may skip the "is this exact?" step.
 * `valueUsdc` is null when the size cannot be priced; such commands always wait for a yes.
 */
export function gateCommand(p: AgentPermission, scope: AgentScope, valueUsdc: number | null, spentToday: number, now: number): GateResult {
  if (!isGrantActive(p, now)) return { allowed: false, reason: 'The agent has no permission yet, or it has expired.' }
  if (!p.scopes[scope]) return { allowed: false, reason: `${SCOPE_LABEL[scope]} are switched off in the agent permission.` }
  if (valueUsdc !== null) {
    if (valueUsdc > p.maxPerCommand) return { allowed: false, reason: `This command is about ${fmt(valueUsdc)} USDC, above your per-command limit of ${fmt(p.maxPerCommand)} USDC.` }
    if (spentToday + valueUsdc > p.dailyLimit) return { allowed: false, reason: `This would take today's total to ${fmt(spentToday + valueUsdc)} USDC, above your daily limit of ${fmt(p.dailyLimit)} USDC.` }
  }
  return { allowed: true, autoRun: p.mode === 'auto' && valueUsdc !== null }
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

const USAGE_KEY = 'lumarc-agent-usage-v1'

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function loadSpentToday(now = Date.now(), storage: Pick<Storage, 'getItem'> = localStorage): number {
  try {
    const raw = JSON.parse(storage.getItem(USAGE_KEY) ?? 'null') as { day?: string; spent?: number } | null
    return raw?.day === today(now) && typeof raw.spent === 'number' && Number.isFinite(raw.spent) ? raw.spent : 0
  } catch {
    return 0
  }
}

export function addSpent(valueUsdc: number, now = Date.now(), storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): number {
  const total = loadSpentToday(now, storage) + valueUsdc
  storage.setItem(USAGE_KEY, JSON.stringify({ day: today(now), spent: total }))
  return total
}

export function clearUsage(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  storage.removeItem(USAGE_KEY)
}
