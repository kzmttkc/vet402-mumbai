import type { ReceiptRow, ReceiptStore } from '../receiptStore'

// Receipts kept in memory. The file store is tested separately, in a temporary folder.
export function memoryStore(): ReceiptStore {
  let rows: ReceiptRow[] = []
  return {
    list: () => rows,
    add: (row) => {
      rows = [row, ...rows]
    },
    update: (id, patch) => {
      rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
    },
  }
}
