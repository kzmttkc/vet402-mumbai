import { useCallback, useEffect, useRef, useState } from 'react'
import { loadReceipts } from '@/lib/publicData'
import type { ReceiptView } from '@/lib/publicData'

export type Receipt = ReceiptView

const REFRESH_MS = 10_000

export function useReceipts() {
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const load = useCallback(async () => {
    const loaded = await loadReceipts()
    // Neither answered. Keep showing what we have, and the next refresh tries again.
    if (!loaded) return
    setReceipts(loaded.receipts)
    // The exported files do not change on a published page, so there is nothing to refresh.
    if (loaded.source === 'static' && import.meta.env.PROD) clearInterval(timer.current)
  }, [])

  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    timer.current = setInterval(() => void load(), REFRESH_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer.current)
    }
  }, [load])

  return { receipts, reload: load }
}
