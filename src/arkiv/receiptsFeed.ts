import { formatUsdc } from '@/onchain-money'
import { LIVE_CHECK_PREFIX } from './schema'

/** The receipts screen reads Arkiv at most this often. */
export const READ_EVERY_MS = 10_000

export const BUSY_LINE = 'Arkiv is busy. Showing saved rows.'

export interface RawReceipt {
  key: string
  expiresAt: bigint
  kind: string
  seller: string
  amountMicro: bigint
  transferId: string
  responseHash: string
  responseBytes: bigint
  timesReceived: bigint
  batchTx: string | null
  paymentKey: string | null
}

export interface RawSeller {
  seller: string
  expiresAt: bigint
}

export interface BlockTiming {
  currentBlock: bigint
  currentBlockTime: number
  blockDuration: number
}

export interface RawRead {
  receipts: RawReceipt[]
  sellers: RawSeller[]
  timing: BlockTiming
}

export interface FeedRow {
  key: string
  seller: string
  /** USDC, as a decimal string. */
  amount: string
  settled: boolean
  batchTx: string | null
  keptUntil: string
  /** Null when the seller has no live entity. */
  sellerActiveUntil: string | null
  responseHash: string
  responseBytes: number
  timesReceived: number
  transferId: string
}

export interface FeedState {
  rows: FeedRow[]
  busy: boolean
}

/** The expiry block as a UTC date. */
export function blockToDate(block: bigint, timing: BlockTiming): string {
  const seconds = timing.currentBlockTime + Number(block - timing.currentBlock) * timing.blockDuration
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

/** One row per payment. A settlement moves its payment's row on, through payment_key. */
export function buildRows({ receipts, sellers, timing }: RawRead): FeedRow[] {
  const settlements = new Map(
    receipts.filter((r) => r.kind === 'settlement' && r.paymentKey).map((r) => [r.paymentKey, r]),
  )
  const sellerExpiry = new Map(sellers.map((s) => [s.seller, s.expiresAt]))

  return receipts
    .filter((r) => r.kind === 'payment' && !r.seller.startsWith(LIVE_CHECK_PREFIX))
    .sort((a, b) => (a.expiresAt < b.expiresAt ? 1 : a.expiresAt > b.expiresAt ? -1 : 0))
    .map((payment) => {
      const settlement = settlements.get(payment.key)
      const sellerUntil = sellerExpiry.get(payment.seller)
      return {
        key: payment.key,
        seller: payment.seller,
        amount: formatUsdc(payment.amountMicro),
        settled: !!settlement,
        batchTx: settlement?.batchTx ?? null,
        keptUntil: blockToDate(payment.expiresAt, timing),
        sellerActiveUntil: sellerUntil === undefined ? null : blockToDate(sellerUntil, timing),
        responseHash: payment.responseHash,
        responseBytes: Number(payment.responseBytes),
        timesReceived: Number(payment.timesReceived),
        transferId: payment.transferId,
      }
    })
}

interface SavedRows {
  load(): FeedRow[]
  save(rows: FeedRow[]): void
}

/** Holds the last rows it read. Any failed read, such as an HTTP 429, leaves them on screen. */
export function createReceiptsFeed(read: () => Promise<RawRead>, saved: SavedRows, now: () => number = Date.now) {
  let state: FeedState = { rows: saved.load(), busy: false }
  let lastReadAt: number | null = null

  return {
    current: () => state,
    /** Reads Arkiv, unless it was read within the last 10 seconds. */
    async refresh(): Promise<FeedState> {
      if (lastReadAt !== null && now() - lastReadAt < READ_EVERY_MS) return state
      lastReadAt = now()
      try {
        const rows = buildRows(await read())
        saved.save(rows)
        state = { rows, busy: false }
      } catch {
        state = { rows: state.rows, busy: true }
      }
      return state
    },
  }
}
