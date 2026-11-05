import { CheckReceipt } from '@/components/CheckReceipt'
import { OpenSealed } from '@/components/OpenSealed'
import { ReceiptList } from '@/components/ReceiptList'
import { StudioWatermark } from '@/components/StudioBadge'
import { TryDispute } from '@/components/TryDispute'
import { useReceipts } from '@/hooks/useReceipts'

const payNothing = () => {}

/** The published screen. It shows receipts and checks them. Only the try at the top pays, a fixed 0.001 USDC of test money. */
export function PublicApp() {
  const { receipts } = useReceipts()

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_8px_32px_rgba(18,45,69,0.06)] backdrop-blur-xl">
        <h1 className="display mb-4 px-1 text-2xl font-semibold">vet402</h1>
        <TryDispute />
        <CheckReceipt />
        <OpenSealed />
        <ReceiptList receipts={receipts} onRetryAsNew={payNothing} busy={false} />
      </section>
      <StudioWatermark />
    </main>
  )
}
