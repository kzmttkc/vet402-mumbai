import { useState } from 'react'
import { Check, Loader2, Sparkles } from 'lucide-react'
import { useJob } from '@/hooks/useJob'

const MAX_JOB_CHARS = 500

const primaryButton =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ink)] px-5 text-base font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:opacity-40'
const ghostButton =
  'flex min-h-11 w-full items-center justify-center rounded-full px-5 text-sm font-semibold text-[var(--muted)] hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]'

export function JobCard({ reload }: { reload: () => Promise<void> }) {
  const [text, setText] = useState('')
  const { state, error, ask, approve, reset } = useJob(reload)

  const job = text.trim()

  return (
    <div className="mt-4 rounded-2xl bg-[var(--surface-muted)] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
          <Sparkles size={20} aria-hidden />
        </span>
        <p className="text-sm text-[var(--muted)]">Job for the agent</p>
      </div>

      {(state.step === 'idle' || state.step === 'planning') && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (job && state.step === 'idle') void ask(job)
          }}
        >
          <label className="block">
            <span className="sr-only">Describe the job</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={MAX_JOB_CHARS}
              rows={3}
              disabled={state.step === 'planning'}
              placeholder="Describe the job in plain words"
              className="w-full resize-none rounded-xl border border-[var(--border)] bg-white p-4 text-base outline-none focus:border-[var(--focus)]"
            />
          </label>
          <button type="submit" disabled={!job || state.step === 'planning'} className={primaryButton}>
            {state.step === 'planning' && <Loader2 size={18} className="animate-spin" aria-hidden />}
            {state.step === 'planning' ? 'Finding someone for the job…' : 'Ask the agent'}
          </button>
        </form>
      )}

      {(state.step === 'asking' || state.step === 'paying') && (
        <div className="mt-4 space-y-4">
          <div className="rounded-xl bg-white p-4">
            <p className="text-lg font-semibold">{state.plan.sellerName}</p>
            <p className="mt-1 text-sm text-pretty text-[var(--muted)]">{state.plan.summary}</p>
          </div>

          <p className="display text-xl font-semibold text-balance">
            May I spend up to <span className="tabular-nums">{state.plan.amount} USDC</span> on this job?
          </p>

          {!state.plan.covered && (
            <p className="text-sm text-[var(--danger)]" role="alert">
              The hold doesn’t cover this. Hold more first.
            </p>
          )}

          <div className="space-y-2">
            <button
              type="button"
              disabled={!state.plan.covered || state.step === 'paying'}
              onClick={() => void approve(state.plan)}
              className={primaryButton}
            >
              {state.step === 'paying' && <Loader2 size={18} className="animate-spin" aria-hidden />}
              {state.step === 'paying' ? 'Working on it…' : `Approve ${state.plan.amount} USDC`}
            </button>
            <button type="button" disabled={state.step === 'paying'} onClick={reset} className={ghostButton}>
              Not now
            </button>
          </div>
        </div>
      )}

      {state.step === 'done' && (
        <div className="mt-4 space-y-4">
          <div className="flex items-start gap-3 rounded-xl bg-white p-4">
            <Check size={20} className="mt-0.5 shrink-0 text-[var(--success)]" aria-hidden />
            <div className="min-w-0">
              <p className="break-words text-base font-semibold text-pretty">{state.result.text}</p>
              <p className="mt-1 text-sm tabular-nums text-[var(--muted)]">Spent {state.result.paid} USDC</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setText('')
              reset()
            }}
            className={primaryButton}
          >
            New job
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
