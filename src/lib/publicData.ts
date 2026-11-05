import type { ReceiptStatus } from './receiptStatus'

/** Where the export writes under public/, and so where the published screen reads. */
export const STATIC_PATHS = {
  receipts: '/static/receipts.json',
  statuses: '/static/statuses.json',
  check: '/static/check.json',
} as const

/** One exported row. `ref` joins it to its status and means nothing else. */
export interface PublicReceipt {
  ref: string
  /** USDC, as a decimal string. */
  amount: string
  sellerName: string
  responseHash: string
  responseBytes: number
  transferId: string | null
  outcome: string[]
}

export interface PublicStatus {
  status: ReceiptStatus
  batchTx: string | null
}

export interface PublicReceiptsFile {
  receipts: PublicReceipt[]
}

export interface PublicStatusesFile {
  statuses: Record<string, PublicStatus>
}

/** What the Check a receipt panel fills in for the event payment. */
export interface CheckFile {
  eventNonce: string | null
  eventTransferId: string | null
}

export interface ReceiptView {
  id: string
  at: string | null
  amount: string
  sellerName: string
  responseHash: string
  responseBytes: number
  /** Null when the row came from the static files, which do not carry it. */
  timesReceived: number | null
  transferId: string | null
  status: ReceiptStatus
  batchTx: string | null
  outcome: string[]
  demo: 'a' | 'b' | 'compare' | null
  comparison: boolean
}

export type ReceiptsSource = 'api' | 'static'

async function readJson(path: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(path)
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  // A published host answers an unknown path with the page itself, so parsing is the real test.
  return (await res.json()) as unknown
}

export function joinStatic(list: PublicReceiptsFile, statuses: PublicStatusesFile): ReceiptView[] {
  return list.receipts.flatMap((row) => {
    const state = statuses.statuses[row.ref]
    if (!state) return []
    return [
      {
        id: row.ref,
        at: null,
        amount: row.amount,
        sellerName: row.sellerName,
        responseHash: row.responseHash,
        responseBytes: row.responseBytes,
        timesReceived: null,
        transferId: row.transferId,
        status: state.status,
        batchTx: state.batchTx,
        outcome: row.outcome,
        // The static rows name no demo, so the screen offers no button that would start a payment.
        demo: null,
        comparison: false,
      },
    ]
  })
}

/** The backend when it answers with JSON, the exported files otherwise. Null when neither can be read. */
export async function loadReceipts(
  fetchImpl: typeof fetch = fetch,
): Promise<{ receipts: ReceiptView[]; source: ReceiptsSource } | null> {
  try {
    const body = (await readJson('/api/receipts', fetchImpl)) as { receipts?: unknown } | null
    if (Array.isArray(body?.receipts)) return { receipts: body.receipts as ReceiptView[], source: 'api' }
  } catch {
    // Falls through to the exported files.
  }
  try {
    const [list, statuses] = await Promise.all([
      readJson(STATIC_PATHS.receipts, fetchImpl) as Promise<PublicReceiptsFile>,
      readJson(STATIC_PATHS.statuses, fetchImpl) as Promise<PublicStatusesFile>,
    ])
    return { receipts: joinStatic(list, statuses), source: 'static' }
  } catch {
    return null
  }
}

/** With no export there is no event payment to offer. The panel still works by typing a nonce. */
export async function loadCheckFile(fetchImpl: typeof fetch = fetch): Promise<CheckFile> {
  try {
    const file = (await readJson(STATIC_PATHS.check, fetchImpl)) as Partial<CheckFile> | null
    return { eventNonce: file?.eventNonce ?? null, eventTransferId: file?.eventTransferId ?? null }
  } catch {
    return { eventNonce: null, eventTransferId: null }
  }
}
