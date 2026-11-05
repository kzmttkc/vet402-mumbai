import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReceiptsPage } from './ReceiptsPage'
import '../index.css'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ReceiptsPage />
    </StrictMode>,
  )
}
