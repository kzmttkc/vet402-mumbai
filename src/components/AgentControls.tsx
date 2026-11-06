import { useId } from 'react'
import { LIMIT_CHOICES } from '@/lib/agentHistory'
import type { LimitChoice, Purchase } from '@/lib/agentHistory'

// The person's own controls for "Ask the agent": how much one job may cost, and what the agent bought from this browser.

/** "Your agent's limit": the most the agent may spend on one job. The server keeps to it, and never goes above its own. */
export function LimitRow({ value, onChange, disabled }: { value: LimitChoice; onChange: (limit: LimitChoice) => void; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl bg-white px-4 py-3">
      <p className="text-sm font-semibold">Your agent’s limit</p>
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <span>Spend up to</span>
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as LimitChoice)}
          className="min-h-11 rounded-lg border border-[var(--border)] bg-white px-2 text-base tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-40"
        >
          {LIMIT_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
        <span>USDC per job</span>
      </label>
    </div>
  )
}

const timeOf = (at: number) => {
  try {
    return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** "What your agent bought": the purchases made from this browser, newest first. */
export function PurchaseList({ purchases }: { purchases: readonly Purchase[] }) {
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">What your agent bought</p>
      {purchases.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--muted)]">Nothing yet. What the agent buys here shows up in this browser.</p>
      ) : (
        <ol className="mt-1 space-y-2">
          {purchases.map((p) => (
            <li key={`${p.at}-${p.sellerName}`} className="rounded-xl bg-white px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-semibold">{p.sellerName}</span>
                <span className="shrink-0 text-sm tabular-nums">{p.amount} USDC</span>
              </div>
              <p className="mt-1 break-words text-sm text-pretty">{p.line}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">{timeOf(p.at)}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
