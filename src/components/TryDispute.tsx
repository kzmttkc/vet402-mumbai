import { readable } from '@/lib/readable'
import { useRef, useState } from 'react'
import { ExternalLink, Loader2, Scale } from 'lucide-react'
import { openSealedAnswer } from '@/lib/openSealed'
import { splitLines } from '@/lib/receiptLines'
import type { OpenResult } from '@/lib/openSealed'
import { EXPLORER_TX, seconds, startTry } from '@/lib/tryDispute'
import type { TryResult, TryStep } from '@/lib/tryDispute'

const primary =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ink)] px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:opacity-40'
const link = 'inline-flex items-center gap-1 text-sm font-semibold underline underline-offset-2'

/** One press runs a real dispute on Arc. The browser opens the box with the key it reads from Arc. The body reads in plain words; the transactions sit under Details. */
export function TryDispute() {
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<TryStep[]>([])
  const [result, setResult] = useState<TryResult | null>(null)
  const [opened, setOpened] = useState<OpenResult | null>(null)
  const startedAt = useRef(0)

  const run = async () => {
    setRunning(true)
    setSteps([])
    setResult(null)
    setOpened(null)
    startedAt.current = performance.now()
    const done = await startTry((step) => setSteps((current) => [...current, step]))
    setResult(done)
    if (done.ok) {
      const answer = { ref: 'try', sellerName: 'Seller A', ...done.box }
      const read = await openSealedAnswer(answer, done.box.contract)
      setSteps((current) => [
        ...current,
        { label: 'Your browser opened the box with the key from Arc', atMs: performance.now() - startedAt.current },
      ])
      setOpened(read)
    }
    setRunning(false)
  }

  return (
    <div className="mb-4 rounded-2xl bg-[var(--surface-muted)] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
          <Scale size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">Try a dispute yourself</p>
          <p className="text-sm text-pretty text-[var(--muted)]">
            vet402 buys an answer for 0.001 USDC. The connection drops before the answer can be opened, and Arc makes the seller hand over the key anyway.
          </p>
        </div>
      </div>

      <button type="button" disabled={running} onClick={() => void run()} className={`${primary} mt-4`}>
        {running && <Loader2 size={16} className="animate-spin" aria-hidden />}
        {running ? 'Running on Arc' : 'Start a dispute'}
      </button>
      <p className="mt-2 text-xs text-[var(--muted)]">It takes about 5 seconds. The payment is test money.</p>

      {steps.length > 0 && (
        <ol className="mt-4 space-y-1" aria-live="polite">
          {steps.map((step, i) => (
            <li key={`${i}-${step.label}`} className="flex items-baseline justify-between gap-3 text-sm">
              <span>{step.label}</span>
              <span className="shrink-0 tabular-nums text-[var(--muted)]">{seconds(step.atMs)}</span>
            </li>
          ))}
        </ol>
      )}

      {result && !result.ok && (
        <p className="mt-3 text-sm font-semibold text-[var(--danger)]" role="status">
          {result.message}
        </p>
      )}

      {result?.ok && <TryOutcome result={result} opened={opened} />}
    </div>
  )
}

/** The plain lines first. What a judge checks (the gas, the claim and both transactions) is one tap away. */
export function TryOutcome({ result, opened }: { result: Extract<TryResult, { ok: true }>; opened: OpenResult | null }) {
  const { plain, details } = splitLines(result.lines)
  return (
    <div className="mt-4 rounded-xl bg-white p-3" role="status">
      {opened?.ok && <p className="break-words text-sm">{readable(opened.text)}</p>}
      {opened && <p className={`mt-1 text-sm ${opened.ok && opened.matches ? '' : 'text-[var(--danger)]'}`}>{opened.line}</p>}
      {plain.map((line) => (
        <p key={line} className="mt-2 text-sm font-semibold">
          {line}
        </p>
      ))}
      {(details.length > 0 || result.claimTx || result.answerTx) && (
        <details className="mt-3 text-xs text-[var(--muted)]">
          <summary className="cursor-pointer select-none font-semibold">Details</summary>
          {details.map((line) => (
            <p key={line} className="mt-2">
              {line}
            </p>
          ))}
          <div className="mt-2 flex flex-wrap gap-4">
            {result.claimTx && (
              <a className={link} href={`${EXPLORER_TX}${result.claimTx}`} target="_blank" rel="noreferrer">
                The claim on Arc <ExternalLink size={14} aria-hidden />
              </a>
            )}
            {result.answerTx && (
              <a className={link} href={`${EXPLORER_TX}${result.answerTx}`} target="_blank" rel="noreferrer">
                The answer on Arc <ExternalLink size={14} aria-hidden />
              </a>
            )}
          </div>
        </details>
      )}
    </div>
  )
}
