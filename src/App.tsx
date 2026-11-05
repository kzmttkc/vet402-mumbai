import { useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { HoldCard } from '@/components/HoldCard'
import { DemoCard } from '@/components/DemoCard'
import { JobCard } from '@/components/JobCard'
import { ReceiptList } from '@/components/ReceiptList'
import { useBalances } from '@/hooks/useBalances'
import { useDemo } from '@/hooks/useDemo'
import { useReceipts } from '@/hooks/useReceipts'

const formatDisplay = (value: string) =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function App() {
  const { data, failed, reload } = useBalances()
  const { receipts, reload: reloadReceipts } = useReceipts()
  const refreshAll = useCallback(async () => {
    await Promise.all([reload(), reloadReceipts()])
  }, [reload, reloadReceipts])
  const demo = useDemo(refreshAll)

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_8px_32px_rgba(18,45,69,0.06)] backdrop-blur-xl">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Your balance</p>
        <div className="mt-2 flex items-baseline gap-2">
          {data ? (
            <span className="display text-5xl font-semibold tabular-nums">{formatDisplay(data.balance)}</span>
          ) : (
            <div aria-hidden className="h-12 w-40 animate-pulse rounded-lg bg-[var(--surface-muted)]" />
          )}
          <span className="text-base font-medium text-[var(--muted)]">USDC</span>
        </div>

        <HoldCard data={data} reload={reload} />
        <JobCard reload={refreshAll} />
        <DemoCard
          run={demo.run}
          error={demo.error}
          running={demo.running}
          start={demo.start}
          sealed={demo.sealed}
          act={demo.act}
          acting={demo.acting}
        />
        <ReceiptList receipts={receipts} onRetryAsNew={() => void demo.start('compare')} busy={demo.running} />

        {failed && (
          <div className="mt-4 flex items-center justify-between gap-3 text-sm text-[var(--danger)]" role="alert">
            <span>Couldn&apos;t load your balances.</span>
            <button
              type="button"
              onClick={() => void reload()}
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
