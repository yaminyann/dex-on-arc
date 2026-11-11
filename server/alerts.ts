/**
 * Operator alerts. With ALERT_WEBHOOK_URL set, new alerts are POSTed as `{ "text": "..." }`
 * (Slack, Discord-compatible bridges and most incident tools accept this). Each alert key is
 * sent at most once per cooldown and again when it clears, so a flapping condition cannot spam.
 * Messages pass through redactSecrets: a webhook is an external destination.
 */
import { redactSecrets } from './security'

type Post = (url: string, body: string) => Promise<unknown>

export class Alerter {
  private active = new Map<string, number>()

  constructor(
    private url: string | undefined,
    private cooldownMs = 15 * 60_000,
    private post: Post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) }),
    private log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** Raises `key` if it is not already active within the cooldown. Returns true when something was sent. */
  async raise(key: string, message: string, now = Date.now()): Promise<boolean> {
    const last = this.active.get(key)
    if (last !== undefined && now - last < this.cooldownMs) return false
    this.active.set(key, now)
    const text = redactSecrets(`[arc-terminal] ALERT ${key}: ${message}`)
    this.log(text)
    return this.send(text)
  }

  /** Marks `key` healthy again and announces the recovery once. */
  async resolve(key: string, message = 'recovered'): Promise<boolean> {
    if (!this.active.has(key)) return false
    this.active.delete(key)
    const text = redactSecrets(`[arc-terminal] RESOLVED ${key}: ${message}`)
    this.log(text)
    return this.send(text)
  }

  /** Raise when `bad`, resolve otherwise. */
  async set(key: string, bad: boolean, message: string, now = Date.now()): Promise<void> {
    if (bad) await this.raise(key, message, now)
    else await this.resolve(key)
  }

  private async send(text: string): Promise<boolean> {
    if (!this.url) return false
    try {
      await this.post(this.url, JSON.stringify({ text }))
      return true
    } catch {
      return false
    }
  }
}

export const alerter = new Alerter(process.env.ALERT_WEBHOOK_URL || undefined)
