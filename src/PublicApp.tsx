import { AskAgent } from '@/components/AskAgent'
import { CheckReceipt } from '@/components/CheckReceipt'
import { OpenSealed } from '@/components/OpenSealed'
import { ReceiptList } from '@/components/ReceiptList'
import { StudioWatermark } from '@/components/StudioBadge'
import { TryDispute } from '@/components/TryDispute'
import { useReceipts } from '@/hooks/useReceipts'

const payNothing = () => {}

const jump =
  'flex min-h-11 items-center justify-center rounded-full border border-[var(--border)] bg-white px-3 text-center text-sm font-semibold text-[var(--ink)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]'

/**
 * The published screen. The agent at the top picks a seller and pays only after Approve, at most the
 * limit the person picks there, never above 0.01 USDC of test money. What it bought stays listed in this
 * browser. The dispute try below pays a fixed 0.001 USDC. The rest reads receipts.
 */
export function PublicApp() {
  const { receipts } = useReceipts()

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_8px_32px_rgba(18,45,69,0.06)] backdrop-blur-xl">
        <h1 className="display px-1 text-2xl font-semibold">vet402</h1>
        <p className="mt-2 px-1 text-base font-medium text-pretty">
          Your agent pays once. If the answer goes missing, the seller’s deposit on Arc pays it back.
        </p>
        <p className="mt-1 px-1 text-xs text-[var(--muted)]">Test money on Arc testnet.</p>
        {/* Two jumps down the page, so a phone sees both things to try before it scrolls. */}
        <nav aria-label="Things to try" className="mb-5 mt-4 grid grid-cols-2 gap-2">
          <a href="#ask-agent" className={jump}>
            Ask your agent
          </a>
          <a href="#try-dispute" className={jump}>
            Try a dispute
          </a>
        </nav>
        <AskAgent />
        <TryDispute />
        {/* The checkers take payment ids, so they sit one tap away instead of on the first screen. */}
        <details className="group mb-4 rounded-2xl bg-[var(--surface-muted)] p-4">
          <summary className="flex min-h-11 cursor-pointer select-none items-center justify-between gap-3 text-sm font-semibold">
            Check a payment yourself
            <span aria-hidden className="text-[var(--muted)] transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>
          <CheckReceipt />
          <OpenSealed />
        </details>
        <ReceiptList receipts={receipts} onRetryAsNew={payNothing} busy={false} />
      </section>
      <StudioWatermark inline />
    </main>
  )
}
