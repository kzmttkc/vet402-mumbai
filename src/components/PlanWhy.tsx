import type { Compared } from '@/lib/askAgent'

/** Why the agent picked this seller, and the top listings it compared. Our own words, never a listing's text. */
export function PlanWhy({ why, compared }: { why?: string; compared?: Compared[] }) {
  if (!why && !compared?.length) return null
  return (
    <div className="space-y-2">
      {why && <p className="text-sm text-pretty">{why}</p>}
      {compared && compared.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Compared</p>
          <ol className="mt-1 space-y-1">
            {compared.map((c, i) => (
              <li key={`${i}-${c.sellerName}-${c.listing}`} className="text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <span className="font-semibold">{c.sellerName}</span>
                    {c.listing && <span className="text-[var(--muted)]"> {c.listing}</span>}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]">{c.amount} USDC</span>
                </div>
                <p className={`text-xs ${c.note === 'Picked' ? 'font-semibold text-[var(--success)]' : 'text-[var(--muted)]'}`}>{c.note}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
