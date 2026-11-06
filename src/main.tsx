/*
 *  ███████╗████████╗██╗   ██╗██████╗ ██╗ ██████╗
 *  ██╔════╝╚══██╔══╝██║   ██║██╔══██╗██║██╔═══██╗
 *  ███████╗   ██║   ██║   ██║██║  ██║██║██║   ██║
 *  ╚════██║   ██║   ██║   ██║██║  ██║██║██║   ██║
 *  ███████║   ██║   ╚██████╔╝██████╔╝██║╚██████╔╝
 *  ╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝
 *
 *  Built with Arc Studio
 *  https://studio.arc.io
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PublicApp } from './PublicApp'
import { installShareSync } from './lib/share'
import './index.css'

installShareSync()

const root = createRoot(document.getElementById('root')!)

// A build is always the published screen. The import below is dropped from it, so no paying route reaches the bundle.
if (import.meta.env.DEV && import.meta.env.VITE_PUBLIC_PREVIEW === '1') {
  // Arc Studio's preview of the published screen. Tracing loads first, so Studio's Tracing panel sees every call it makes.
  void import('./tracing').then(() =>
    root.render(
      <StrictMode>
        <PublicApp />
      </StrictMode>,
    ),
  )
} else if (import.meta.env.DEV) {
  void import('./studio-root').then(({ renderStudio }) => renderStudio(root))
} else {
  root.render(
    <StrictMode>
      <PublicApp />
    </StrictMode>,
  )
}
