/** Hands a command from another page (the landing page) to the Agent input, once. */
const KEY = 'lumarc-agent-prefill'

export function setAgentPrefill(command: string): void {
  try {
    sessionStorage.setItem(KEY, command)
  } catch {
    /* private mode: the agent simply opens empty */
  }
}

export function takeAgentPrefill(): string {
  try {
    const v = sessionStorage.getItem(KEY) ?? ''
    sessionStorage.removeItem(KEY)
    return v.slice(0, 200)
  } catch {
    return ''
  }
}
