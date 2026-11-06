import { useEffect, useMemo, useRef, useState } from 'react'
import { Receipt as ReceiptIcon } from 'lucide-react'
import { receiptStatusLine } from '@/lib/receiptStatus'
import { CheckSeller } from './CheckSeller'
import type { SellerSample } from './CheckSeller'
import { createArkivReader, createRulingsReader } from './readArkiv'
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

/** The seller the sample button fills in. Arc ruled against it, so the check has something to show. */
export const SAMPLE_SELLER = 'Seller F'

/** The sample seller's payTo, from the newest receipt on Arkiv that names it. Never typed by hand. */
export function sampleSeller(rows: readonly FeedRow[], name = SAMPLE_SELLER): SellerSample | null {
  const row = rows.find((r) => r.seller === name && typeof r.payTo === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.payTo))
  return row?.payTo ? { name, payTo: row.payTo } : null
}

/** The page's own path, so the link back works on any host. */
const HOME = '/'

export function ReceiptsPage() {
  const [state, setState] = useState<FeedState>(() => ({ rows: savedRows.load(), busy: false }))
  const [writer, setWriter] = useState<Hex | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Every writer's rulings, each kept once Arc confirms it. vet402's own address names it in the answer.
  const readRulings = useMemo(() => (writer ? createRulingsReader(writer, undefined, {}, 'any') : null), [writer])

  useEffect(() => {
    const life = new AbortController()

    void findWriter().then((writer) => {
      if (life.signal.aborted || !writer) return
      setWriter(writer)
      const feed = createReceiptsFeed(createArkivReader(writer), savedRows)
      const tick = async () => {
        const next = await feed.refresh()
        if (life.signal.aborted) return
        setState(next)
        timer.current = setTimeout(() => void tick(), READ_EVERY_MS)
      }
      void tick()
    })

    return () => {
      life.abort()
      clearTimeout(timer.current)
    }
  }, [])

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-10">
      <header className="mb-4 px-1">
        <a
          href={HOME}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--ink)] underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
        >
          ← Back to vet402
        </a>
        <h1 className="display mt-1 text-2xl font-semibold">Receipts on Arkiv</h1>
        <p className="mt-1 text-sm text-pretty text-[var(--muted)]">
          Payments vet402 made, kept on Arkiv where anyone can read them. Check a seller here before your agent pays it.
        </p>
      </header>
      <CheckSeller read={readRulings} sample={sampleSeller(state.rows)} />
      <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_8px_32px_rgba(18,45,69,0.06)] backdrop-blur-xl">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Receipts</h2>

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

/** What "Got back" and "Received" count, for a row where either is 0. */
export const COUNTS_NOTE =
  'Got back and Received count only what came over the connection when vet402 paid. An answer that Arc delivered later lives on Arc.'

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
          {row.ruledAgainst && (
            <p className="mt-1 text-sm text-pretty text-[var(--danger)]">Arc ruled against this seller on {row.ruledAgainst}</p>
          )}
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
          {(row.responseBytes === 0 || row.timesReceived === 0) && (
            <p className="mt-2 text-xs text-pretty text-[var(--muted)]">{COUNTS_NOTE}</p>
          )}
        </div>
      </div>
    </li>
  )
}
