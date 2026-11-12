import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Panel } from './ui'

interface Props {
  children: ReactNode
  /** Changing this value clears a caught error, so moving to another page recovers. */
  resetKey?: string
}

/** A crash in one page shows a message with a way out, not a blank screen. */
export class ErrorBoundary extends Component<Props, { error: Error | null; key?: string }> {
  state: { error: Error | null; key?: string } = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <Panel raised className="mx-auto mt-6 max-w-xl p-6">
        <h1 className="text-2xl">This page failed to load</h1>
        <p className="mt-2 text-sm text-mute">Something threw an error while drawing this page. Your funds and settings are not affected. The message below helps when you report it.</p>
        <pre className="num mt-3 max-h-40 overflow-auto border border-line bg-raised p-3 text-xs">{this.state.error.message}</pre>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button onClick={() => location.reload()}>Reload the app</Button>
        </div>
      </Panel>
    )
  }
}
