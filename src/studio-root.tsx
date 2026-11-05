import './tracing'
import './console-capture'

import { StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { StudioWatermark } from '@/components/StudioBadge'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { Toaster } from 'sonner'
import { config } from './config'
import App from './App'

const queryClient = new QueryClient()

// Studio logo SVG
/** The full app. It only exists in the dev server, so a build never holds a paying route. */
export function renderStudio(root: Root) {
  root.render(
    <StrictMode>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <ConnectKitProvider>
            <App />
            <StudioWatermark />
            <Toaster position="top-center" />
          </ConnectKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>,
  )
}
