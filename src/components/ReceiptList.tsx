import { Receipt as ReceiptIcon } from 'lucide-react'
import type { Receipt } from '@/hooks/useReceipts'
import { receiptStatusLine } from '@/lib/receiptStatus'

const short = (value: string, keep = 10) => (value.length > keep ? `${value.slice(0, keep)}…` : value)

export function ReceiptList({ receipts }: { receipts: Receipt[] }) {
  if (receipts.length === 0) return null

  return (
    <div className="mt-4">
      <p className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Receipts</p>
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
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
