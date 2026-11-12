import './tracing'
import './console-capture'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { config } from './config'
import App from './App'
import { installShareSync } from './lib/share'
import './index.css'

const queryClient = new QueryClient()

installShareSync()

// The wallet dialog takes the same square, ink-bordered look as the rest of the app.
const walletTheme = {
  '--ck-font-family': "'Archivo', sans-serif",
  '--ck-border-radius': '0px',
  '--ck-overlay-background': 'rgba(0, 0, 0, 0.6)',
  '--ck-body-background': 'rgb(var(--panel))',
  '--ck-body-color': 'rgb(var(--fg))',
  '--ck-body-color-muted': 'rgb(var(--muted))',
  '--ck-primary-button-background': 'rgb(var(--accent))',
  '--ck-primary-button-color': 'rgb(var(--accent-fg))',
  '--ck-secondary-button-background': 'rgb(var(--panel2))',
  '--ck-secondary-button-color': 'rgb(var(--fg))',
  '--ck-secondary-button-border-radius': '0px',
  '--ck-primary-button-border-radius': '0px',
  '--ck-modal-box-shadow': '5px 5px 0 0 rgb(var(--fg))',
} as const

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider customTheme={walletTheme}>
          <App />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
