import { useCallback, useEffect, useState } from 'react'

export type DemoKind = 'a' | 'b' | 'compare'

export type StepName = 'hold' | 'payment' | 'waiting' | 'connection dropped' | 'fetching again' | 'delivered'

export interface DemoRun {
  id: string
  kind: DemoKind
  state: 'running' | 'done' | 'failed'
  steps: { name: StepName; atMs: number }[]
  error: string | null
}

const POLL_MS = 1000
const FALLBACK_ERROR = 'Something went wrong. Please try again.'

export function useDemo(onChange: () => Promise<void>) {
  const [run, setRun] = useState<DemoRun | null>(null)
  const [error, setError] = useState<string | null>(null)

  const running = run?.state === 'running'
  const runId = run?.id

  const start = useCallback(
    async (kind: DemoKind) => {
      setError(null)
      try {
        const res = await fetch(kind === 'compare' ? '/api/demo/compare' : '/api/demo/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(kind === 'compare' ? {} : { seller: kind }),
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

  return { run, error, start, running }
}
