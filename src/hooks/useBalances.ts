import { useCallback, useEffect, useState } from 'react'

export interface HoldView {
  state: 'none' | 'setting-up' | 'active' | 'used-up'
  amount: string
  remaining: string
}

export interface Balances {
  balance: string
  hold: HoldView
}

const REFRESH_MS = 10_000

export function useBalances() {
  const [data, setData] = useState<Balances | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/balances')
      if (!res.ok) throw new Error('request failed')
      setData((await res.json()) as Balances)
      setFailed(false)
    } catch {
      setFailed(true)
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

  return { data, failed, reload: load }
}
