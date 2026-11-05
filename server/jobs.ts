import { randomUUID } from 'node:crypto'
import { formatUsdc } from '../src/onchain-money'
import type { Candidate } from './discovery'
import { isPaymentJob, planJob } from './planner'
import type { LatestReceipt, Plan, PlanFailure, PlannedRequest } from './planner'

/** Everything the job flow needs from the outside world. Real versions live in jobPorts.ts. */
export interface JobPorts {
  candidates(): Promise<Candidate[]>
  /** The newest row of the agent's payment history, or null when there is none. */
  latestReceipt(): Promise<LatestReceipt | null>
  /** What the hold still has to spend, in atomic USDC units. */
  holdAvailable(): Promise<bigint>
  /** Pays the seller from the hold and returns its answer. Must refuse to pay more than `cap`. */
  pay(request: PlannedRequest, cap: bigint): Promise<{ data: unknown; paid: bigint }>
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

export function createJobService(ports: JobPorts, now: () => number = Date.now) {
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

      let paid: { data: unknown; paid: bigint }
      try {
        // The approved amount is the most the agent may spend on this job.
        paid = await ports.pay(approved.request, approved.amount)
      } catch (error) {
        console.error('job payment failed:', error instanceof Error ? error.message : error)
        throw new JobError('PAY_FAILED')
      }

      return {
        text: approved.kind === 'receipt-check' ? describeReceipt(paid.data) : describeAnswer(paid.data),
        paid: formatUsdc(paid.paid),
      }
    } finally {
      busy = false
    }
  }

  return { plan, approve }
}
