import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type TransferStatus = 'received' | 'batched' | 'confirmed' | 'completed' | 'failed'

export const TRANSFER_STATUSES: readonly TransferStatus[] = ['received', 'batched', 'confirmed', 'completed', 'failed']

/** One row per payment. Money is in atomic USDC units, as a string. */
export interface ReceiptRow {
  id: string
  /** ISO time the payment was made. */
  at: string
  amount: string
  sellerName: string
  /** SHA-256 of the response body, hex. */
  responseHash: string
  /** Size of the response body in bytes. */
  responseBytes: number
  /** How many times the paid response came back to us. */
  timesReceived: number
  /** Gateway's id for the transfer, once it can be found. */
  transferId: string | null
  /** The payment's unique nonce, used to find the transfer until its id is known. Never shown. */
  nonce: string | null
  status: TransferStatus
  /** The onchain batch transaction, once Gateway reports one. */
  batchTx: string | null
  /** Plain sentences about how the payment ended. Set by the recovery demo. */
  outcome?: string[]
  /** Which demo made this row, so the screen can offer the right demo button. */
  demo?: 'a' | 'b' | 'compare'
  /** True for rows from the comparison job. They never use the "No second charge." sentence. */
  comparison?: boolean
}

export interface ReceiptStore {
  /** Newest first. */
  list(): ReceiptRow[]
  add(row: ReceiptRow): void
  update(id: string, patch: Partial<Pick<ReceiptRow, 'transferId' | 'status' | 'batchTx' | 'outcome'>>): void
}

const FILE_NAME = 'receipts.json'
const MAX_ROWS = 200

const isRow = (value: unknown): value is ReceiptRow => {
  const r = value as Partial<ReceiptRow> | null
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.at === 'string' &&
    typeof r.amount === 'string' &&
    typeof r.sellerName === 'string' &&
    typeof r.responseHash === 'string' &&
    typeof r.responseBytes === 'number' &&
    typeof r.timesReceived === 'number' &&
    typeof r.status === 'string' &&
    TRANSFER_STATUSES.includes(r.status as TransferStatus)
  )
}

// The folder is always passed in, so tests can point it at a temporary directory.
export function createReceiptStore(dir: string): ReceiptStore {
  const file = path.join(dir, FILE_NAME)

  function read(): ReceiptRow[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isRow) : []
    } catch {
      return []
    }
  }

  function write(rows: ReceiptRow[]): void {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(rows.slice(0, MAX_ROWS)), { mode: 0o600 })
    renameSync(tmp, file)
  }

  return {
    list: read,
    add(row) {
      write([row, ...read()])
    },
    update(id, patch) {
      write(read().map((row) => (row.id === id ? { ...row, ...patch } : row)))
    },
  }
}
