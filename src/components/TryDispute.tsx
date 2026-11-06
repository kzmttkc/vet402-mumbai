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

/** Where a try stands. `finishing` means the outcome is known and only the follow-up work is still running. */
type Phase = 'idle' | 'running' | 'finishing'

/** One small line for work that is still going on after the outcome is known. */
function Pending({ children }: { children: string }) {
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-[var(--muted)]">
      <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/**
 * One press runs a real dispute on Arc. The browser opens the box with the key it reads from Arc. The body reads in
 * plain words, with a link to the dispute on Arc, and the rest sits under Details.
 *
 * The server sends the result as soon as the run ends, then keeps the stream open while it writes the try to the
 * public record on Arkiv. The button stops at "Delivered" or at the result, whichever comes first, and the work that
 * is still running gets its own small line.
 */
export function TryDispute() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [steps, setSteps] = useState<TryStep[]>([])
  const [result, setResult] = useState<TryResult | null>(null)
  const [opened, setOpened] = useState<OpenResult | null>(null)
  const [opening, setOpening] = useState(false)
  const [recording, setRecording] = useState(false)
  const startedAt = useRef(0)

  const delivered = steps.some((step) => step.name === 'delivered')

  const open = async (done: Extract<TryResult, { ok: true }>) => {
    setOpening(true)
    const answer = { ref: 'try', sellerName: 'Seller A', ...done.box }
    // A public RPC can refuse one read under load, so a failed read gets two more tries before the line shows.
    let read = await openSealedAnswer(answer, done.box.contract)
    for (let retry = 0; retry < 2 && !read.ok; retry++) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      read = await openSealedAnswer(answer, done.box.contract)
    }
    setSteps((current) => [
      ...current,
      { label: 'Your browser opened the box with the key from Arc', atMs: performance.now() - startedAt.current },
    ])
    setOpened(read)
    setOpening(false)
  }

  const run = async () => {
    setPhase('running')
    setSteps([])
    setResult(null)
    setOpened(null)
    setOpening(false)
    setRecording(false)
    startedAt.current = performance.now()
    // Filled from the callback, so it is an object and not a narrowed local.
    const seen: { result: TryResult | null; opens: Promise<void> | null } = { result: null, opens: null }
    const final = await startTry(
      (step) => {
        setSteps((current) => [...current, step])
        if (step.name === 'delivered') setPhase('finishing')
      },
      fetch,
      (done) => {
        seen.result = done
        setResult(done)
        if (!done.ok) return
        setPhase('finishing')
        setRecording(true)
        seen.opens = open(done)
      },
      (record) => setSteps((current) => [...current, record]),
    )
    if (!seen.result) setResult(final)
    setRecording(false)
    await seen.opens
    setPhase('idle')
  }

  return (
    <div id="try-dispute" className="mb-4 scroll-mt-4 rounded-2xl bg-[var(--surface-muted)] p-4">
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

      <button type="button" disabled={phase !== 'idle'} onClick={() => void run()} className={`${primary} mt-4`}>
        {phase === 'running' && <Loader2 size={16} className="animate-spin" aria-hidden />}
        {phase === 'running' ? 'Running on Arc' : phase === 'finishing' ? 'Done on Arc' : 'Start a dispute'}
      </button>
      <p className="mt-2 text-xs text-[var(--muted)]">It takes about 5 seconds. The payment is test money.</p>

      {result && !result.ok && (
        <p className="mt-3 text-sm font-semibold text-[var(--danger)]" role="status">
          {result.message}
        </p>
      )}

      {result?.ok && <TryOutcome result={result} opened={opened} />}

      {delivered && !result && <Pending>Checking Circle’s record of the payment</Pending>}
      {opening && <Pending>Your browser is opening the box with the key from Arc</Pending>}
      {recording && <Pending>Writing this try to the public record on Arkiv</Pending>}

      {steps.length > 0 && (
        <ol className="mt-4 space-y-1" aria-live="polite">
          {steps.map((step, i) => (
            <li key={`${i}-${step.label}`} className="flex items-baseline justify-between gap-3 text-sm">
              {step.href ? (
                <a className="min-w-0 font-semibold underline underline-offset-2" href={step.href} target="_blank" rel="noreferrer">
                  {step.label}
                  <ExternalLink size={14} className="ml-1 inline align-[-2px]" aria-hidden />
                </a>
              ) : (
                <span>{step.label}</span>
              )}
              <span className="shrink-0 tabular-nums text-[var(--muted)]">{seconds(step.atMs)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** The plain lines and the link to the dispute on Arc first. What a judge checks (the gas, the claim and both transactions) is one tap away. */
export function TryOutcome({ result, opened }: { result: Extract<TryResult, { ok: true }>; opened: OpenResult | null }) {
  const { plain, details } = splitLines(result.lines)
  return (
    <div className="mt-4 rounded-xl bg-white p-3" role="status">
      {plain.map((line, i) => (
        <p key={line} className={`${i > 0 ? 'mt-2 ' : ''}text-sm font-semibold`}>
          {line}
        </p>
      ))}
      {result.claimTx && (
        <a className={`${link} mt-2`} href={`${EXPLORER_TX}${result.claimTx}`} target="_blank" rel="noreferrer">
          The dispute on Arc <ExternalLink size={14} aria-hidden />
        </a>
      )}
      {opened?.ok && <p className="mt-3 break-words text-sm">{readable(opened.text)}</p>}
      {opened && <p className={`mt-1 text-sm ${opened.ok && opened.matches ? '' : 'text-[var(--danger)]'}`}>{opened.line}</p>}
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
