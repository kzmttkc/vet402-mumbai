export type ReceiptStatus = 'received' | 'batched' | 'confirmed' | 'completed' | 'failed'

/** The one line a receipt row shows for Gateway's status. */
export function receiptStatusLine(status: ReceiptStatus, batchTx: string | null): string {
  switch (status) {
    case 'completed':
      return batchTx ? `Settled in batch ${batchTx}` : 'Settled in batch'
    case 'failed':
      return 'Failed. Nothing was charged.'
    case 'received':
    case 'batched':
    case 'confirmed':
      return 'Accepted. Not settled yet.'
  }
}
