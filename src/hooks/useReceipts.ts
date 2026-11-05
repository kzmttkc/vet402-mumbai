import { useCallback, useEffect, useState } from 'react'
import type { ReceiptStatus } from '@/lib/receiptStatus'

export interface Receipt {
  id: string
  at: string
  amount: string
  sellerName: string
  responseHash: string
  responseBytes: number
  timesReceived: number
  transferId: string | null
  status: ReceiptStatus
  batchTx: string | null
  /** Plain sentences about how the payment ended. */
  outcome: string[]
  demo: 'a' | 'b' | 'compare' | null
  comparison: boolean
}

const REFRESH_MS = 10_000

export function useReceipts() {
  const [receipts, setReceipts] = useState<Receipt[]>([])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/receipts')
      if (!res.ok) return
      setReceipts(((await res.json()) as { receipts: Receipt[] }).receipts)
    } catch {
      // Keep showing what we have. The next refresh tries again.
    }
  }, [])

  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [load])

  return { receipts, reload: load }
}
