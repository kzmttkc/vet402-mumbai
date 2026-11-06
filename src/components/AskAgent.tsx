import { readable } from '@/lib/readable'
import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, Loader2, ShieldCheck, Sparkles } from 'lucide-react'
import { OWN_SELLER_MARK, PlanWhy } from '@/components/PlanWhy'
import { approvePlan, arcTxUrl, askAgent, receiptLine, settlementOf } from '@/lib/askAgent'
import type { AgentPlan as Plan, Compared, Paid as PaidReply } from '@/lib/askAgent'
import { splitLines } from '@/lib/receiptLines'

/** The card as the server sends it. A pick that seals has the protection line, vet402's own seller says so, and every card says the limit. */
type AgentPlan = Plan & { protection?: string; own?: boolean; limitLine?: string }
/** A sealed answer's receipt has its own lines. Technical ones start with "Detail: ". */
type Paid = PaidReply & { lines?: string[] }

const MAX_JOB_CHARS = 500
const EXAMPLES = ['Did my last payment go through?', 'Get me a paid access receipt', "What's the weather in Mumbai?"]
/** How often, and for how long, the card asks whether the payment has settled. */
const SETTLE_POLL_MS = 5_000
const SETTLE_WATCH_MS = 3 * 60_000

const primary =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ink)] px-5 text-base font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:opacity-40'
const ghost =
  'flex min-h-11 w-full items-center justify-center rounded-full px-5 text-sm font-semibold text-[var(--muted)] hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-40'
const chip =
  'min-h-9 rounded-full border border-[var(--border)] bg-white px-3 text-sm hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-40'
const link = 'inline-flex items-center gap-1 text-sm font-semibold underline underline-offset-2'

type State =
  | { step: 'idle' }
  | { step: 'planning' }
  | { step: 'declined'; message: string; compared: Compared[] }
  | { step: 'asking'; plan: AgentPlan }
  | { step: 'paying'; plan: AgentPlan }
  | { step: 'done'; paid: Paid }

/** The question on the card, with the limit under it. A pick that seals, with a deposit that covers it, also has the protection line. */
export function SpendQuestion({ plan }: { plan: Pick<AgentPlan, 'amount' | 'protection' | 'limitLine'> }) {
  return (
    <>
      <p className="display text-xl font-semibold text-balance">
        May I spend up to <span className="tabular-nums">{plan.amount} USDC</span> on this job?
      </p>
      {plan.limitLine && <p className="text-sm text-pretty text-[var(--muted)]">{plan.limitLine}</p>}
      {plan.protection && (
        <p className="flex items-start gap-2 text-sm text-pretty">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--success)]" aria-hidden />
          <span>{plan.protection}</span>
        </p>
      )}
    </>
  )
}

/** A sealed answer's receipt: the plain lines first, the technical ones under Details. */
export function SealedLines({ lines }: { lines?: string[] }) {
  const { plain, details } = splitLines(lines ?? [])
  if (!plain.length && !details.length) return null
  return (
    <div>
      {plain.map((line) => (
        <p key={line} className="text-sm font-semibold text-pretty">
          {line}
        </p>
      ))}
      {details.length > 0 && (
        <details className="mt-2 text-xs text-[var(--muted)]">
          <summary className="cursor-pointer select-none font-semibold">Details</summary>
          {details.map((line) => (
            <p key={line} className="mt-2 break-words">
              {line}
            </p>
          ))}
        </details>
      )}
    </div>
  )
}

/** "Ask the agent": it picks a seller from the Arc catalog, asks before it spends, and shows a plain receipt. */
export function AskAgent() {
  const [text, setText] = useState('')
  const [state, setState] = useState<State>({ step: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState<{ done: boolean; batchTx: string | null }>({ done: false, batchTx: null })
  const asked = useRef('')

  const job = text.trim()
  const busy = state.step === 'planning' || state.step === 'paying'

  const ask = async (words: string) => {
    setError(null)
    asked.current = words
    setState({ step: 'planning' })
    const answer = await askAgent(words)
    setState(answer.ok ? { step: 'asking', plan: answer.plan } : { step: 'declined', message: answer.message, compared: answer.compared })
  }

  const approve = async (plan: AgentPlan) => {
    setError(null)
    setState({ step: 'paying', plan })
    const reply = await approvePlan(asked.current, plan.id)
    if (!reply.ok) {
      setError(reply.message)
      setState({ step: 'asking', plan })
      return
    }
    setSettled({ done: reply.value.status === 'completed' && !!arcTxUrl(reply.value.batchTx), batchTx: reply.value.batchTx })
    setState({ step: 'done', paid: reply.value })
  }

  const reset = () => {
    setError(null)
    setState({ step: 'idle' })
  }

  // After a payment, ask now and then whether it has settled on Arc, for a few minutes at most.
  const transferId = state.step === 'done' ? state.paid.transferId : null
  useEffect(() => {
    if (!transferId || settled.done) return
    const watch = { stopped: false, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    const started = Date.now()
    const tick = async () => {
      if (watch.stopped || Date.now() - started > SETTLE_WATCH_MS) return
      const reply = await settlementOf(transferId)
      if (watch.stopped) return
      if (reply.ok && reply.value.status === 'completed' && arcTxUrl(reply.value.batchTx)) {
        setSettled({ done: true, batchTx: reply.value.batchTx })
        return
      }
      watch.timer = setTimeout(() => void tick(), SETTLE_POLL_MS)
    }
    watch.timer = setTimeout(() => void tick(), SETTLE_POLL_MS)
    return () => {
      watch.stopped = true
      clearTimeout(watch.timer)
    }
  }, [transferId, settled.done])

  return (
    <div className="mb-4 rounded-2xl bg-[var(--surface-muted)] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
          <Sparkles size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">Ask the agent</p>
          <p className="text-sm text-pretty text-[var(--muted)]">
            It picks a seller from Circle’s Arc catalog and asks you before it spends. The money is test money.
          </p>
        </div>
      </div>

      {(state.step === 'idle' || state.step === 'planning' || state.step === 'declined') && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (job && !busy) void ask(job)
          }}
        >
          <label className="block">
            <span className="sr-only">What should the agent do?</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={MAX_JOB_CHARS}
              rows={2}
              disabled={busy}
              placeholder="Did my last payment go through?"
              className="w-full resize-none rounded-xl border border-[var(--border)] bg-white p-4 text-base outline-none focus:border-[var(--focus)]"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={busy}
                onClick={() => {
                  setText(example)
                  void ask(example)
                }}
                className={chip}
              >
                {example}
              </button>
            ))}
          </div>
          <button type="submit" disabled={!job || busy} className={primary}>
            {state.step === 'planning' && <Loader2 size={18} className="animate-spin" aria-hidden />}
            {state.step === 'planning' ? 'Reading the catalog…' : 'Ask'}
          </button>
        </form>
      )}

      {state.step === 'declined' && (
        <div className="mt-4 space-y-3 rounded-xl bg-white p-4" role="status">
          <p className="text-base font-semibold text-pretty">{state.message}</p>
          <PlanWhy compared={state.compared} />
        </div>
      )}

      {(state.step === 'asking' || state.step === 'paying') && (
        <div className="mt-4 space-y-4">
          {state.plan.notices?.map((notice) => (
            <p key={notice} className="text-sm font-medium text-pretty" role="status">
              {notice}
            </p>
          ))}
          <div className="space-y-3 rounded-xl bg-white p-4">
            <div>
              <p className="text-lg font-semibold">{state.plan.sellerName}</p>
              {state.plan.own && (
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">{OWN_SELLER_MARK}</p>
              )}
              <p className="mt-1 text-sm text-pretty text-[var(--muted)]">{state.plan.summary}</p>
              {state.plan.delivery && <p className="mt-1 text-sm text-pretty">{state.plan.delivery}</p>}
            </div>
            <PlanWhy why={state.plan.why} compared={state.plan.compared} />
          </div>

          <SpendQuestion plan={state.plan} />

          {!state.plan.covered && (
            <p className="text-sm text-[var(--danger)]" role="alert">
              The agent’s test money has run out for now. Nothing will be paid.
            </p>
          )}

          <div className="space-y-2">
            <button
              type="button"
              disabled={!state.plan.covered || state.step === 'paying'}
              onClick={() => void approve(state.plan)}
              className={primary}
            >
              {state.step === 'paying' && <Loader2 size={18} className="animate-spin" aria-hidden />}
              {state.step === 'paying' ? 'Working on it…' : 'Approve'}
            </button>
            <button type="button" disabled={state.step === 'paying'} onClick={reset} className={ghost}>
              Not now
            </button>
          </div>
        </div>
      )}

      {state.step === 'done' && (
        <div className="mt-4 space-y-4">
          <div className="flex items-start gap-3 rounded-xl bg-white p-4" role="status">
            <Check size={20} className="mt-0.5 shrink-0 text-[var(--success)]" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="break-words text-base font-semibold text-pretty">{readable(state.paid.text)}</p>
              <p className="text-sm text-[var(--muted)]">
                {state.paid.sellerName} · {receiptLine(state.paid.paid, settled.done)}
              </p>
              <SealedLines lines={state.paid.lines} />
              {settled.done && arcTxUrl(settled.batchTx) && (
                <a className={link} href={arcTxUrl(settled.batchTx) as string} target="_blank" rel="noreferrer">
                  View on Arc <ExternalLink size={14} aria-hidden />
                </a>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setText('')
              setSettled({ done: false, batchTx: null })
              reset()
            }}
            className={primary}
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
