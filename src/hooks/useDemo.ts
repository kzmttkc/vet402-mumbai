import { useCallback, useEffect, useState } from 'react'

export type DemoKind = 'a' | 'b' | 'compare' | 'd' | 'e' | 'f'

export type StepName =
  | 'hold'
  | 'payment'
  | 'waiting'
  | 'connection dropped'
  | 'fetching again'
  | 'claim'
  | 'key on chain'
  | 'opened'
  | 'delivered'

export type DemoAction = 'finalize' | 'prove' | 'withdraw'

export interface DemoRun {
  id: string
  kind: DemoKind
  state: 'running' | 'done' | 'failed'
  steps: { name: StepName; atMs: number }[]
  error: string | null
  action: DemoAction | null
}

const POLL_MS = 1000
const FALLBACK_ERROR = 'Something went wrong. Please try again.'

export function useDemo(onChange: () => Promise<void>) {
  const [run, setRun] = useState<DemoRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sealed, setSealed] = useState(false)
  const [acting, setActing] = useState(false)

  const running = run?.state === 'running'
  const runId = run?.id

  const start = useCallback(
    async (kind: DemoKind, lineUp = false) => {
      setError(null)
      try {
        const res = await fetch(kind === 'compare' ? '/api/demo/compare' : '/api/demo/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(kind === 'compare' ? {} : { seller: kind, lineUp }),
        })
        const body = (await res.json().catch(() => null)) as (DemoRun & { error?: string }) | null
        if (!res.ok || !body) throw new Error(body?.error ?? FALLBACK_ERROR)
        setRun(body)
      } catch (e) {
        setError(e instanceof Error ? e.message : FALLBACK_ERROR)
      }
    },
    [],
  )

  // Sellers D, E and F exist only when the backend has the contract.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/demo/options')
        if (res.ok) setSealed(((await res.json()) as { sealed?: unknown }).sealed === true)
      } catch {
        // Without an answer the screen offers Seller A and Seller B, as it always did.
      }
    })()
  }, [])

  const act = useCallback(
    async (action: DemoAction) => {
      if (!runId) return
      setError(null)
      setActing(true)
      try {
        const res = await fetch(`/api/demo/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST' })
        const body = (await res.json().catch(() => null)) as (DemoRun & { error?: string }) | null
        if (!res.ok || !body) throw new Error(body?.error ?? FALLBACK_ERROR)
        setRun(body)
        await onChange()
      } catch (e) {
        setError(e instanceof Error ? e.message : FALLBACK_ERROR)
      } finally {
        setActing(false)
      }
    },
    [runId, onChange],
  )

  // While a run is going, ask how far it got, and keep the receipts fresh.
  useEffect(() => {
    if (!running || !runId) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/demo/runs/${encodeURIComponent(runId)}`)
          if (res.ok) setRun((await res.json()) as DemoRun)
        } catch {
          // The next tick tries again.
        }
        await onChange()
      })()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [running, runId, onChange])

  return { run, error, start, running, sealed, act, acting }
}
