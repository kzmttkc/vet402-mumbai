import { useEffect, useState } from 'react'
import { Receipt as ReceiptIcon } from 'lucide-react'
import { receiptStatusLine } from '@/lib/receiptStatus'
import { createArkivReader } from './readArkiv'
import { BUSY_LINE, createReceiptsFeed, READ_EVERY_MS } from './receiptsFeed'
import type { FeedRow, FeedState } from './receiptsFeed'
import type { Hex } from 'viem'

const SAVED_KEY = 'vet402.receipts.rows'

const savedRows = {
  load(): FeedRow[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')
      return Array.isArray(parsed) ? (parsed as FeedRow[]) : []
    } catch {
      return []
    }
  },
  save(rows: FeedRow[]) {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(rows))
    } catch {
      // Rows stay on screen for this visit. There is just nothing to come back to.
    }
  },
}

/** Written into the page at build time. Asking the backend is only a fallback for a build with none. */
async function findWriter(): Promise<Hex | null> {
  if (__ARKIV_WRITER__) return __ARKIV_WRITER__ as Hex
  try {
    const res = await fetch('/api/writer')
    if (!res.ok) return null
    return ((await res.json()) as { address: Hex | null }).address
  } catch {
    return null
  }
}

const short = (value: string, keep = 10) => (value.length > keep ? `${value.slice(0, keep)}…` : value)

export function ReceiptsPage() {
  const [state, setState] = useState<FeedState>(() => ({ rows: savedRows.load(), busy: false }))

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    void findWriter().then((writer) => {
      if (stopped || !writer) return
      const feed = createReceiptsFeed(createArkivReader(writer), savedRows)
      const tick = async () => {
        const next = await feed.refresh()
        if (stopped) return
        setState(next)
        timer = setTimeout(() => void tick(), READ_EVERY_MS)
      }
      void tick()
    })

    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-10">
      <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_8px_32px_rgba(18,45,69,0.06)] backdrop-blur-xl">
        <h1 className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Receipts</h1>

        {state.busy && (
          <p className="mt-3 px-1 text-sm text-[var(--muted)]" role="status">
            {BUSY_LINE}
          </p>
        )}

        {state.rows.length === 0 ? (
          <p className="mt-3 px-1 text-sm text-[var(--muted)]">No receipts yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {state.rows.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

function Row({ row }: { row: FeedRow }) {
  return (
    <li className="rounded-2xl bg-[var(--surface-muted)] p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
          <ReceiptIcon size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-base font-semibold">{row.seller}</p>
            <p className="shrink-0 text-base font-semibold tabular-nums">{row.amount} USDC</p>
          </div>
          <p
            className={`mt-1 break-all text-sm text-pretty ${row.settled ? 'text-[var(--success)]' : 'text-[var(--muted)]'}`}
          >
            {receiptStatusLine(row.settled ? 'completed' : 'received', row.batchTx)}
          </p>
          <p className="mt-1 text-sm text-pretty">Kept outside this app until {row.keptUntil}</p>
          {row.sellerActiveUntil && <p className="mt-1 text-sm text-pretty">Seller active until {row.sellerActiveUntil}</p>}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
            <dt>Got back</dt>
            <dd className="tabular-nums" title={row.responseHash}>
              {row.responseBytes} bytes, fingerprint {short(row.responseHash)}
            </dd>
            <dt>Received</dt>
            <dd className="tabular-nums">{row.timesReceived === 1 ? 'once' : `${row.timesReceived} times`}</dd>
            <dt>Transfer</dt>
            <dd className="tabular-nums" title={row.transferId}>
              {short(row.transferId, 13)}
            </dd>
          </dl>
        </div>
      </div>
    </li>
  )
}
