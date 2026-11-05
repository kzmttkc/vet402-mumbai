import { useCallback, useState } from 'react'

export function useStartHold(onDone: () => Promise<void>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(
    async (amount: string) => {
      setPending(true)
      setError(null)
      try {
        const res = await fetch('/api/hold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? 'The hold could not be set up. Please try again.')
        }
        await onDone()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The hold could not be set up. Please try again.')
      } finally {
        setPending(false)
      }
    },
    [onDone],
  )

  return { start, pending, error }
}
