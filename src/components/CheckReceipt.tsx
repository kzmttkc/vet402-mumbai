import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Hex } from 'viem'
import { createArkivCounter } from '@/arkiv/readArkiv'
import { checkReceipt, PRE_EVENT_NONCE } from '@/lib/checkReceipt'
import type { CheckResult } from '@/lib/checkReceipt'
import { loadCheckFile } from '@/lib/publicData'
import type { CheckFile } from '@/lib/publicData'

const NO_FILE: CheckFile = { eventNonce: null, eventTransferId: null }

export function CheckReceipt() {
  const [file, setFile] = useState<CheckFile>(NO_FILE)
  const [nonce, setNonce] = useState(PRE_EVENT_NONCE)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  // Only the newest check may fill the result.
  const latest = useRef(0)

  const countEntities = useMemo(() => (__ARKIV_WRITER__ ? createArkivCounter(__ARKIV_WRITER__ as Hex) : null), [])

  useEffect(() => {
    let stopped = false
    void loadCheckFile().then((loaded) => {
      if (stopped) return
      setFile(loaded)
      if (loaded.eventNonce) setNonce(loaded.eventNonce)
    })
    return () => {
      stopped = true
    }
  }, [])

  const run = async (value: string) => {
    if (!value.trim()) return
    const mine = ++latest.current
    setChecking(true)
    const isEvent = value.trim().toLowerCase() === file.eventNonce?.toLowerCase()
    const next = await checkReceipt(value, {
      countEntities,
      knownTransferId: isEvent ? file.eventTransferId : null,
    })
    if (mine !== latest.current) return
    setResult(next)
    setChecking(false)
  }

  const fill = (value: string) => {
    setNonce(value)
    void run(value)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(nonce)
  }

  const prefillClass =
    'flex min-h-11 items-center justify-center rounded-full border border-[var(--border)] bg-white px-4 text-sm font-semibold hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]'

  return (
    <div>
      <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Check a receipt</h2>
      <form onSubmit={submit} className="mt-2 rounded-2xl bg-[var(--surface-muted)] p-4">
        <label htmlFor="payment-nonce" className="text-sm font-medium">
          Payment nonce
        </label>
        <input
          id="payment-nonce"
          name="nonce"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={nonce}
          onChange={(event) => setNonce(event.target.value)}
          className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-xs tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {file.eventNonce && (
            <button type="button" onClick={() => fill(file.eventNonce as string)} className={prefillClass}>
              Event payment
            </button>
          )}
          <button type="button" onClick={() => fill(PRE_EVENT_NONCE)} className={prefillClass}>
            Pre-event payment
          </button>
          <button
            type="submit"
            disabled={checking}
            className="flex min-h-11 items-center justify-center rounded-full bg-[var(--ink)] px-5 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-40"
          >
            Check
          </button>
        </div>
        <div aria-live="polite" className="mt-3 space-y-1 text-sm text-pretty">
          {result?.circle.map((line, i) => (
            <p key={`${i}-${line}`}>{line}</p>
          ))}
          {result && <p>{result.arkiv}</p>}
        </div>
      </form>
    </div>
  )
}
