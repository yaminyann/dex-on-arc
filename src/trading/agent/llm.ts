/**
 * Client for the optional chat model (POST /api/agent-chat). The backend decides whether it is on; the
 * browser only calls it for wording the built-in rules could not read. The answer is text plus at most
 * one command, and the command is checked again here with the same strict parser before it is used.
 */
import { parseCommand } from './parser'

export interface ModelAnswer {
  reply: string
  command: string | null
}

export async function askAgentModel(text: string, tokens: string[], quote: string, signal?: AbortSignal): Promise<ModelAnswer> {
  const res = await fetch('/api/agent-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 300), tokens: tokens.slice(0, 80), quote }),
    signal: signal ?? AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    let message = 'The chat model did not answer.'
    try {
      const j = (await res.json()) as { error?: { message?: string } }
      if (j.error?.message) message = j.error.message
    } catch {
      // keep the default message
    }
    throw new Error(message)
  }
  const data = (await res.json()) as { reply?: unknown; command?: unknown }
  const reply = typeof data.reply === 'string' ? data.reply.slice(0, 400) : ''
  const command = typeof data.command === 'string' && parseCommand(data.command).ok ? data.command : null
  return { reply, command }
}
