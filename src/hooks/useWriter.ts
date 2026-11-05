import { useEffect, useState } from 'react'

/** The address receipts are written from, or null when the app runs on local receipts alone. */
export function useWriter() {
  const [writer, setWriter] = useState<string | null>(__ARKIV_WRITER__ || null)

  useEffect(() => {
    // Written in at build time, so the published screen has it with no backend.
    if (__ARKIV_WRITER__) return
    let stopped = false
    void (async () => {
      try {
        const res = await fetch('/api/writer')
        if (!res.ok) return
        const { address } = (await res.json()) as { address: string | null }
        if (!stopped) setWriter(address)
      } catch {
        // No backend, so nothing to offer from here.
      }
    })()
    return () => {
      stopped = true
    }
  }, [])

  return writer
}
