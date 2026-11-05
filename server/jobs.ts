import { createHash, randomUUID } from 'node:crypto'
import { formatUsdc } from '../src/onchain-money'
import type { Candidate } from './discovery'
import { isPaymentJob, planJob } from './planner'
import type { LatestReceipt, Plan, PlanFailure, PlannedRequest } from './planner'
import type { ReceiptRow, ReceiptStore, TransferStatus } from './receiptStore'

/** What Gateway says about one transfer. */
export interface TransferInfo {
  id: string
  status: TransferStatus
  /** The onchain batch transaction, once there is one. */
  txHash: string | null
}

export interface PayOutcome {
  /** The seller's answer. */
  data: unknown
  /** The answer exactly as it arrived, as text. The receipt's hash and size are taken over this. */
  body?: string
  /** Atomic USDC units actually paid. */
  paid: bigint
  /** The payment's unique nonce. */
  nonce: string | null
  /** How many times the paid response came back. */
  timesReceived: number
  /** Whatever Gateway returned as the settlement reference. */
  transaction: string
}

/** Everything the job flow needs from the outside world. Real versions live in jobPorts.ts. */
export interface JobPorts {
  candidates(): Promise<Candidate[]>
  /** The newest row of the agent's payment history, or null when there is none. */
  latestReceipt(): Promise<LatestReceipt | null>
  /** What the hold still has to spend, in atomic USDC units. */
  holdAvailable(): Promise<bigint>
  /** Pays the seller from the hold and returns its answer. Must refuse to pay more than `cap`. */
  pay(request: PlannedRequest, cap: bigint): Promise<PayOutcome>
  /** Finds a payment's Gateway transfer by its nonce, trying up to `attempts` times. */
  findTransfer(nonce: string, attempts?: number): Promise<TransferInfo | null>
  /** Reads one Gateway transfer by id. */
  fetchTransfer(id: string): Promise<TransferInfo>
}

export type JobErrorCode = PlanFailure | 'UNKNOWN_PLAN' | 'NOT_COVERED' | 'BUSY' | 'PAY_FAILED'

const MESSAGES: Record<JobErrorCode, string> = {
  EMPTY_JOB: 'Describe the job first.',
  NO_SELLER: 'I couldn’t find anyone who can do this job.',
  NO_PAYMENTS: 'There is no payment to check yet.',
  NOT_SETTLED: 'Your latest payment is still being processed. Try again in a moment.',
  UNKNOWN_PLAN: 'That request has expired. Describe the job again.',
  NOT_COVERED: 'The hold doesn’t cover this. Hold more first.',
  BUSY: 'The agent is already working on a job.',
  PAY_FAILED: 'The job couldn’t be completed.',
}

export class JobError extends Error {
  readonly code: JobErrorCode

  constructor(code: JobErrorCode) {
    super(MESSAGES[code])
    this.name = 'JobError'
    this.code = code
  }
}

/** What the approval card shows: the seller's name, one plain sentence, and the amount. Nothing else. */
export interface PlanView {
  id: string
  sellerName: string
  summary: string
  /** USDC, as a decimal string. */
  amount: string
  covered: boolean
}

export interface JobResult {
  text: string
  /** USDC actually paid, as a decimal string. */
  paid: string
}

/** A receipt row as the screen sees it. */
export interface ReceiptView {
  id: string
  at: string
  /** USDC, as a decimal string. */
  amount: string
  sellerName: string
  responseHash: string
  responseBytes: number
  timesReceived: number
  transferId: string | null
  status: TransferStatus
  batchTx: string | null
  outcome: string[]
  demo: 'a' | 'b' | 'compare' | null
  comparison: boolean
}

const LOOKUP_ATTEMPTS = 4
const REFRESH_LIMIT = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isFinal = (status: TransferStatus) => status === 'completed' || status === 'failed'

function toView(row: ReceiptRow): ReceiptView {
  return {
    id: row.id,
    at: row.at,
    amount: formatUsdc(BigInt(row.amount)),
    sellerName: row.sellerName,
    responseHash: row.responseHash,
    responseBytes: row.responseBytes,
    timesReceived: row.timesReceived,
    transferId: row.transferId,
    status: row.status,
    batchTx: row.batchTx,
    outcome: row.outcome ?? [],
    demo: row.demo ?? null,
    comparison: row.comparison ?? false,
  }
}

/** The body as received, as text. The hash and size are taken over exactly this. */
export function responseBody(data: unknown): string {
  return typeof data === 'string' ? data : (JSON.stringify(data) ?? '')
}

const PLAN_TTL_MS = 10 * 60 * 1000
const MAX_RESULT_CHARS = 600

interface Stored {
  plan: Plan
  expiresAt: number
}

/** Reads the relay's answer to eth_getTransactionReceipt in plain words. */
export function describeReceipt(data: unknown): string {
  const result = (data as { result?: unknown } | null)?.result
  if (result === null || result === undefined) return 'It hasn’t been confirmed yet.'
  const status = (result as { status?: unknown }).status
  if (status === '0x1' || status === 1) return 'Yes, your payment went through.'
  return 'No, that payment didn’t go through.'
}

function describeAnswer(data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  if (!text) return 'Done.'
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text
}

export function createJobService(ports: JobPorts, receipts: ReceiptStore, now: () => number = Date.now) {
  const plans = new Map<string, Stored>()
  let busy = false

  function sweep() {
    for (const [id, stored] of plans) if (stored.expiresAt <= now()) plans.delete(id)
  }

  async function plan(job: string): Promise<PlanView> {
    sweep()
    const candidates = await ports.candidates()
    // Only look at payment history when the job is about it, and then only once.
    const latest = isPaymentJob(job) ? await ports.latestReceipt() : null

    const outcome = planJob(job, candidates, latest)
    if (!outcome.ok) throw new JobError(outcome.reason)

    const id = randomUUID()
    plans.set(id, { plan: outcome.plan, expiresAt: now() + PLAN_TTL_MS })

    return {
      id,
      sellerName: outcome.plan.sellerName,
      summary: outcome.plan.summary,
      amount: formatUsdc(outcome.plan.amount),
      covered: (await ports.holdAvailable()) >= outcome.plan.amount,
    }
  }

  async function approve(id: string): Promise<JobResult> {
    sweep()
    const stored = plans.get(id)
    if (!stored) throw new JobError('UNKNOWN_PLAN')
    if (busy) throw new JobError('BUSY')

    busy = true
    try {
      const { plan: approved } = stored
      if ((await ports.holdAvailable()) < approved.amount) throw new JobError('NOT_COVERED')

      // An approval is used once, so a double tap can never pay twice.
      plans.delete(id)

      let paid: PayOutcome
      try {
        // The approved amount is the most the agent may spend on this job.
        paid = await ports.pay(approved.request, approved.amount)
      } catch (error) {
        console.error('job payment failed:', error instanceof Error ? error.message : error)
        throw new JobError('PAY_FAILED')
      }

      await recordReceipt(approved, paid)

      return {
        text: approved.kind === 'receipt-check' ? describeReceipt(paid.data) : describeAnswer(paid.data),
        paid: formatUsdc(paid.paid),
      }
    } finally {
      busy = false
    }
  }

  // One row per payment. A seller that answered without charging leaves no row.
  async function recordReceipt(approved: Plan, paid: PayOutcome): Promise<void> {
    if (paid.paid <= 0n) return

    const body = paid.body ?? responseBody(paid.data)
    let transfer: TransferInfo | null = null
    try {
      if (paid.nonce) transfer = await ports.findTransfer(paid.nonce, LOOKUP_ATTEMPTS)
      if (!transfer && UUID.test(paid.transaction)) transfer = await ports.fetchTransfer(paid.transaction)
    } catch (error) {
      // The money has moved, so a slow lookup must not hide the receipt. It is retried on refresh.
      console.error('transfer lookup failed:', error instanceof Error ? error.message : error)
    }

    receipts.add({
      id: randomUUID(),
      at: new Date(now()).toISOString(),
      amount: paid.paid.toString(),
      sellerName: approved.sellerName,
      responseHash: createHash('sha256').update(body).digest('hex'),
      responseBytes: Buffer.byteLength(body),
      timesReceived: paid.timesReceived,
      transferId: transfer?.id ?? null,
      nonce: paid.nonce,
      status: transfer?.status ?? 'received',
      batchTx: transfer?.txHash ?? null,
    })
  }

  /** Receipt rows, newest first, with any unsettled ones brought up to date from Gateway. */
  async function listReceipts(refresh = true): Promise<ReceiptView[]> {
    const open = (refresh ? receipts.list() : [])
      .filter((row) => !isFinal(row.status))
      .slice(0, REFRESH_LIMIT)

    await Promise.all(
      open.map(async (row) => {
        try {
          const transfer = row.transferId
            ? await ports.fetchTransfer(row.transferId)
            : row.nonce
              ? await ports.findTransfer(row.nonce)
              : null
          if (!transfer) return
          if (transfer.id !== row.transferId || transfer.status !== row.status || transfer.txHash !== row.batchTx) {
            receipts.update(row.id, { transferId: transfer.id, status: transfer.status, batchTx: transfer.txHash })
          }
        } catch {
          // Keep what we have. The next refresh tries again.
        }
      }),
    )

    return receipts.list().map(toView)
  }

  return { plan, approve, listReceipts }
}
