import { Loader2, Unplug } from 'lucide-react'
import type { DemoKind, DemoRun, StepName } from '@/hooks/useDemo'

const STEP_LABELS: Record<StepName, string> = {
  hold: 'Hold',
  payment: 'Payment',
  waiting: 'Waiting',
  'connection dropped': 'Connection dropped',
  'fetching again': 'Fetching again',
  delivered: 'Delivered',
}

const RUN_TITLES: Record<DemoKind, string> = {
  a: 'Seller A',
  b: 'Seller B',
  compare: 'Comparison only. vet402 does not do this.',
}

const secondary =
  'flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full border border-[var(--border)] bg-white px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:opacity-40'

interface Props {
  run: DemoRun | null
  error: string | null
  running: boolean
  start: (kind: DemoKind) => Promise<void>
}

export function DemoCard({ run, error, running, start }: Props) {
  return (
    <div className="mt-4 rounded-2xl bg-[var(--surface-muted)] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
          <Unplug size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm text-[var(--muted)]">Lost-answer demo</p>
          <p className="text-sm text-pretty">Each seller charges 0.001 USDC, then the connection drops.</p>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <button type="button" disabled={running} onClick={() => void start('a')} className={secondary}>
          Try Seller A
        </button>
        <button type="button" disabled={running} onClick={() => void start('b')} className={secondary}>
          Try Seller B
        </button>
      </div>

      {error && (
        <p className="mt-3 text-sm text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}

      {run && <Progress run={run} />}
    </div>
  )
}

function Progress({ run }: { run: DemoRun }) {
  return (
    <div className="mt-4 rounded-xl bg-white p-4" aria-live="polite">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Progress</p>
      <p className="mt-1 text-sm font-semibold text-pretty">{RUN_TITLES[run.kind]}</p>
      <ol className="mt-3 space-y-1.5">
        {run.steps.map((step, index) => (
          <li key={`${step.name}-${index}`} className="flex items-baseline justify-between gap-3 text-sm">
            <span>{STEP_LABELS[step.name]}</span>
            <span className="tabular-nums text-[var(--muted)]">{(step.atMs / 1000).toFixed(1)} s</span>
          </li>
        ))}
      </ol>
      {run.state === 'running' && (
        <p className="mt-3 flex items-center gap-2 text-sm text-[var(--muted)]">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          Working…
        </p>
      )}
      {run.state === 'failed' && run.error && (
        <p className="mt-3 text-sm text-[var(--danger)]" role="alert">
          {run.error}
        </p>
      )}
    </div>
  )
}
