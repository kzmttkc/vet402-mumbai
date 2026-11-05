import { Receipt as ReceiptIcon } from 'lucide-react'
import type { Receipt } from '@/hooks/useReceipts'
import { useWriter } from '@/hooks/useWriter'
import { receiptStatusLine } from '@/lib/receiptStatus'

const short = (value: string, keep = 10) => (value.length > keep ? `${value.slice(0, keep)}…` : value)

interface Props {
  receipts: Receipt[]
  /** Demo only: start the comparison job. */
  onRetryAsNew: () => void
  busy: boolean
}

export function ReceiptList({ receipts, onRetryAsNew, busy }: Props) {
  const writer = useWriter()
  if (receipts.length === 0) return null

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Receipts</p>
        {writer && (
          <a href="/receipts.html" className="text-xs font-semibold text-[var(--ink)] underline">
            Open receipts
          </a>
        )}
      </div>
      <ul className="mt-2 space-y-2">
        {receipts.map((r) => (
          <li key={r.id} className="rounded-2xl bg-[var(--surface-muted)] p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
                <ReceiptIcon size={18} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-base font-semibold">{r.sellerName}</p>
                  <p className="shrink-0 text-base font-semibold tabular-nums">{r.amount} USDC</p>
                </div>
                <p
                  className={`mt-1 break-all text-sm text-pretty ${r.status === 'failed' ? 'text-[var(--danger)]' : r.status === 'completed' ? 'text-[var(--success)]' : 'text-[var(--muted)]'}`}
                >
                  {receiptStatusLine(r.status, r.batchTx)}
                </p>
                {r.outcome.map((line) => (
                  <p key={line} className="mt-1 text-sm font-medium text-pretty">
                    {line}
                  </p>
                ))}
                {r.comparison && (
                  <p className="mt-1 text-xs font-semibold text-[var(--danger)]">
                    Comparison only. vet402 does not do this.
                  </p>
                )}
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
                  <dt>Got back</dt>
                  <dd className="tabular-nums" title={r.responseHash}>
                    {r.responseBytes} bytes, fingerprint {short(r.responseHash)}
                  </dd>
                  <dt>Received</dt>
                  <dd className="tabular-nums">{r.timesReceived === 1 ? 'once' : `${r.timesReceived} times`}</dd>
                  <dt>Transfer</dt>
                  <dd className="tabular-nums" title={r.transferId ?? undefined}>
                    {r.transferId ? short(r.transferId, 13) : 'Not assigned yet'}
                  </dd>
                </dl>
                {r.demo === 'b' && (
                  <div className="mt-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={onRetryAsNew}
                      className="flex min-h-11 w-full items-center justify-center rounded-full border border-[var(--border)] bg-white px-4 text-sm font-semibold hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-40"
                    >
                      Retry as a new payment
                    </button>
                    <p className="mt-1 text-center text-xs text-[var(--muted)]">Demo only</p>
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
