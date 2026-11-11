/**
 * Request-trust helpers for the backend. Kept free of Bun/Node globals other than node:crypto
 * so they can be unit tested.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Resolves the caller's address for rate limiting.
 *
 * `x-forwarded-for` is attacker-controlled unless a proxy you operate appends to it, so it is
 * only read when `trustedHops` > 0 (the number of proxies in front of this process). The client
 * address is then the entry `trustedHops` from the right, which is the one your outermost trusted
 * proxy recorded; anything the client put further left is ignored.
 */
export function resolveClientIp(forwardedFor: string | null, socketIp: string | undefined, trustedHops: number): string {
  if (trustedHops > 0 && forwardedFor) {
    const parts = forwardedFor
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const picked = parts[parts.length - trustedHops]
    if (picked) return picked
  }
  return socketIp || 'local'
}

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Browser-origin gate. Empty `allowed` disables the check. A request passes when its Origin, or
 * failing that its Referer's origin, is on the list. Non-browser clients can forge these headers,
 * so this reduces casual abuse only; the per-IP and global budgets are the real protection.
 */
export function originAllowed(origin: string | null, referer: string | null, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true
  const list = allowed.map(normalizeOrigin)
  if (origin) return list.includes(normalizeOrigin(origin))
  if (referer) {
    try {
      return list.includes(normalizeOrigin(new URL(referer).origin))
    } catch {
      return false
    }
  }
  return false
}

export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Constant-time bearer token check. An unset or empty token never matches. */
export function bearerMatches(authorization: string | null, token: string | undefined): boolean {
  if (!token || !authorization?.startsWith('Bearer ')) return false
  const given = createHash('sha256').update(authorization.slice(7)).digest()
  const expected = createHash('sha256').update(token).digest()
  return timingSafeEqual(given, expected)
}

export function isLoopback(ip: string | undefined): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/**
 * Operator access (detailed /health, /metrics). With ADMIN_TOKEN set, only a matching bearer token
 * passes. Without one, only a direct loopback connection passes, and a request carrying
 * `x-forwarded-for` is treated as proxied, so a local reverse proxy does not open it to the world.
 * Set ADMIN_TOKEN in any deployed environment.
 */
export function isOperator(headers: Headers, socketIp: string | undefined, adminToken: string | undefined): boolean {
  if (adminToken) return bearerMatches(headers.get('authorization'), adminToken)
  return isLoopback(socketIp) && !headers.has('x-forwarded-for')
}

/** Removes URLs (RPC endpoints can carry tokens) and 32-byte hex strings from text shown to clients. */
export function redactSecrets(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '[url]').replace(/0x[0-9a-fA-F]{64}/g, '[redacted]')
}
