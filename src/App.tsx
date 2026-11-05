import { Bot, RefreshCw } from 'lucide-react'
import { useBalances } from '@/hooks/useBalances'

const formatDisplay = (value: string) =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Amount({ value, className }: { value: string | undefined; className: string }) {
  if (value === undefined) {
    return <div aria-hidden className={`animate-pulse rounded-lg bg-[var(--surface-muted)] ${className}`} />
  }
  return <span className={`display tabular-nums ${className}`}>{formatDisplay(value)}</span>
}

export default function App() {
  const { data, failed, retry } = useBalances()

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_8px_32px_rgba(18,45,69,0.06)] backdrop-blur-xl">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Your balance</p>
        <div className="mt-2 flex items-baseline gap-2">
          {data ? (
            <Amount value={data.balance} className="text-5xl font-semibold text-balance" />
          ) : (
            <Amount value={undefined} className="h-12 w-40" />
          )}
          <span className="text-base font-medium text-[var(--muted)]">USDC</span>
        </div>

        <div className="mt-6 flex items-center gap-3 rounded-2xl bg-[var(--surface-muted)] p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
            <Bot size={20} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-[var(--muted)]">Agent budget</p>
            {data ? (
              <p className="text-lg font-semibold">
                <Amount value={data.agentBudget} className="text-lg font-semibold" />{' '}
                <span className="text-sm font-medium text-[var(--muted)]">USDC</span>
              </p>
            ) : (
              <Amount value={undefined} className="mt-1 h-6 w-24" />
            )}
          </div>
        </div>

        {failed && (
          <div className="mt-4 flex items-center justify-between gap-3 text-sm text-[var(--danger)]" role="alert">
            <span>Couldn&apos;t load your balances.</span>
            <button
              type="button"
              onClick={() => void retry()}
              className="flex min-h-11 items-center gap-1.5 rounded-full px-3 font-semibold text-[var(--ink)] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
            >
              <RefreshCw size={14} aria-hidden />
              Retry
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
