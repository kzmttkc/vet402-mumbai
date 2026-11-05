import { useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
import type { WorldApproval } from '@/hooks/useWorldApproval'

const primaryButton =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ink)] px-5 text-base font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:opacity-40'
const secondaryButton =
  'flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-[var(--border)] bg-white px-5 text-sm font-semibold text-[var(--ink)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]'
const ghostButton =
  'flex min-h-11 w-full items-center justify-center rounded-full px-5 text-sm font-semibold text-[var(--muted)] hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]'

const COPIED_MS = 1500

export function WorldHoldActions({
  world,
  amount,
  text,
  busy,
}: {
  world: WorldApproval
  amount: string | null
  text: string
  busy: boolean
}) {
  const [copied, setCopied] = useState(false)
  const { request } = world
  const waiting = request?.state === 'waiting'
  const creating = request?.state === 'creating'
  // Every sentence about a request comes from the backend. A closed request reads as a refusal.
  const refused = request?.state === 'closed'

  async function copy() {
    await world.copy()
    setCopied(true)
    setTimeout(() => setCopied(false), COPIED_MS)
  }

  return (
    <div className="space-y-3">
      {request && !creating && (
        <p
          className={`text-sm font-medium text-pretty ${refused ? 'text-[var(--danger)]' : ''}`}
          role={refused ? 'alert' : undefined}
          aria-live="polite"
        >
          {request.message}
        </p>
      )}

      {waiting ? (
        <>
          {world.qr && (
            <figure className="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border)] bg-white p-4">
              <img src={world.qr} alt="QR code for this approval request" width={224} height={224} className="h-56 w-56" />
              <figcaption className="text-center text-sm text-[var(--muted)]">Scan with World App on your phone</figcaption>
            </figure>
          )}
          {world.canCopy && (
            <button type="button" onClick={() => void copy()} className={secondaryButton}>
              {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
              Copy the simulator request
            </button>
          )}
          {request.kind === 'hold' && world.hasLastApproval && (
            <button type="button" onClick={() => void world.useLastApproval()} className={secondaryButton}>
              Use the last approval
            </button>
          )}
          <button type="button" onClick={() => void world.cancel()} className={ghostButton}>
            Cancel request
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={!amount || busy || creating}
          onClick={() => {
            if (!amount) return
            void (world.budgetSet ? world.hold(amount) : world.setBudget(amount))
          }}
          className={primaryButton}
        >
          {(busy || creating) && <Loader2 size={18} className="animate-spin" aria-hidden />}
          {busy || creating
            ? 'Setting up the hold…'
            : world.budgetSet
              ? `Hold ${amount ?? text} USDC for this job`
              : `Set budget ${amount ?? text} USDC`}
        </button>
      )}

      {world.error && (
        <p className="text-sm text-[var(--danger)]" role="alert">
          {world.error}
        </p>
      )}
    </div>
  )
}
