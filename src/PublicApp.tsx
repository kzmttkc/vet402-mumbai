import { AskAgent } from '@/components/AskAgent'
import { CheckReceipt } from '@/components/CheckReceipt'
import { OpenSealed } from '@/components/OpenSealed'
import { ReceiptList } from '@/components/ReceiptList'
import { StudioWatermark } from '@/components/StudioBadge'
import { TryDispute } from '@/components/TryDispute'
import { useReceipts } from '@/hooks/useReceipts'

const payNothing = () => {}

/**
 * The published screen. The agent at the top picks a seller and pays only after Approve, at most
 * 0.01 USDC of test money. The dispute try below pays a fixed 0.001 USDC. The rest reads receipts.
 */
export function PublicApp() {
  const { receipts } = useReceipts()

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_8px_32px_rgba(18,45,69,0.06)] backdrop-blur-xl">
        <h1 className="display mb-4 px-1 text-2xl font-semibold">vet402</h1>
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
      <StudioWatermark />
    </main>
  )
}
