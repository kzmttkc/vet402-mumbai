import { useCallback, useState } from 'react'

export interface PlanView {
  id: string
  sellerName: string
  summary: string
  amount: string
  covered: boolean
  /** One sentence per seller the agent passed over. */
  notices?: string[]
  /** What the delivery check found. */
  delivery?: string
}

export interface JobResult {
  text: string
  paid: string
}

export type JobState =
  | { step: 'idle' }
  | { step: 'planning' }
  | { step: 'asking'; plan: PlanView }
  | { step: 'paying'; plan: PlanView }
  | { step: 'done'; result: JobResult }

const FALLBACK_ERROR = 'Something went wrong. Please try again.'

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) {
    const failure = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(failure?.error ?? FALLBACK_ERROR)
  }
  return (await res.json()) as T
}

export function useJob(onPaid: () => Promise<void>) {
  const [state, setState] = useState<JobState>({ step: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const ask = useCallback(async (job: string) => {
    setError(null)
    setState({ step: 'planning' })
    try {
      setState({ step: 'asking', plan: await post<PlanView>('/api/jobs/plan', { job }) })
    } catch (e) {
      setError(e instanceof Error ? e.message : FALLBACK_ERROR)
      setState({ step: 'idle' })
    }
  }, [])

  // Demo only: the expiry scene. It is the normal flow from the approval card on.
  const askSellerC = useCallback(async () => {
    setError(null)
    setState({ step: 'planning' })
    try {
      setState({ step: 'asking', plan: await post<PlanView>('/api/demo/seller-c') })
    } catch (e) {
      setError(e instanceof Error ? e.message : FALLBACK_ERROR)
      setState({ step: 'idle' })
    }
  }, [])

  const approve = useCallback(
    async (plan: PlanView) => {
      setError(null)
      setState({ step: 'paying', plan })
      try {
        const result = await post<JobResult>(`/api/jobs/${encodeURIComponent(plan.id)}/approve`)
        setState({ step: 'done', result })
        await onPaid()
      } catch (e) {
        setError(e instanceof Error ? e.message : FALLBACK_ERROR)
        setState({ step: 'asking', plan })
      }
    },
    [onPaid],
  )

  const reset = useCallback(() => {
    setError(null)
    setState({ step: 'idle' })
  }, [])

  return { state, error, ask, askSellerC, approve, reset }
}
