import { useState } from 'react'
import type { FormEvent } from 'react'
import { arcCheckedLine, CLEAR_LINE, checkSeller, NOT_ADDRESS_LINE, notPaidLine, shortClaim, UNREAD_LINE, verdictLabel } from './sellerCheck'
import type { RulingsRead, SellerAnswer } from './sellerCheck'

/** What one check says, in the receipts page's words. */
export function SellerAnswerView({ answer }: { answer: SellerAnswer }) {
  if (answer.kind === 'not-address') return <p>{NOT_ADDRESS_LINE}</p>
  if (answer.kind === 'unread') return <p>{UNREAD_LINE}</p>
  if (answer.kind === 'clear') return <p className="text-[var(--success)]">{CLEAR_LINE}</p>
  const claim = shortClaim(answer.claimId)
  return (
    <>
      <p className="text-[var(--danger)]">
        Arc ruled against this seller on {answer.date} ({verdictLabel(answer.verdict)}). Claim{' '}
        {answer.claimUrl ? (
          <a className="underline" href={answer.claimUrl} target="_blank" rel="noreferrer" title={answer.claimId}>
            {claim}
          </a>
        ) : (
          <span title={answer.claimId}>{claim}</span>
        )}{' '}
        on Arc.
      </p>
      {answer.checkedOnArc && <p>{arcCheckedLine(answer.verdict)}</p>}
      {answer.notPaidUntil && <p>{notPaidLine(answer.notPaidUntil)}</p>}
    </>
  )
}

/**
 * Anyone can ask Arkiv about a seller from here, before paying it. The browser reads the public
 * endpoint itself, so the answer does not depend on vet402's backend.
 */
export function CheckSeller({ read }: { read: ((payTo: string) => Promise<RulingsRead>) | null }) {
  const [input, setInput] = useState('')
  const [answer, setAnswer] = useState<SellerAnswer | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setAnswer(await checkSeller(input, read ?? (() => Promise.reject(new Error('no writer')))))
    setBusy(false)
  }

  return (
    <section className="mb-4 rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_8px_32px_rgba(18,45,69,0.06)] backdrop-blur-xl">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Check a seller</h2>
      <form onSubmit={(event) => void submit(event)} className="mt-2 rounded-2xl bg-[var(--surface-muted)] p-4">
        <label htmlFor="seller-pay-to" className="text-sm font-medium">
          Seller's payTo address
        </label>
        <input
          id="seller-pay-to"
          name="payTo"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-white px-3 text-xs tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy}
            className="flex min-h-11 items-center justify-center rounded-full bg-[var(--ink)] px-5 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-40"
          >
            Check
          </button>
        </div>
        <div aria-live="polite" className="mt-3 space-y-1 text-sm text-pretty">
          {answer && <SellerAnswerView answer={answer} />}
        </div>
      </form>
    </section>
  )
}
