import { createHash, randomUUID } from 'node:crypto'
import { formatUsdc } from '../src/onchain-money'
import { NOT_PAID } from './arkiv'
import type { SellerCheck } from './arkiv'
import type { Candidate } from './discovery'
import { decide, needsLatestPayment, planCheapest, rankJob } from './planner'
import type { Compared, LatestReceipt, Plan, PlanFailure, PlanOutcome, PlannedRequest, SellerSignal } from './planner'
import type { ReceiptRow, ReceiptStore, TransferStatus } from './receiptStore'
import { SELLER_C_NAME } from './sellers'

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
  OVER_LIMIT: 'The seller that fits asks more than I may spend. Nothing was paid.',
  NO_PAYMENTS: 'There is no payment to check yet.',
  NOT_SETTLED: 'Your latest payment is still being processed. Try again in a moment.',
  UNKNOWN_PLAN: 'That request has expired. Describe the job again.',
  NOT_COVERED: 'The hold doesn’t cover this. Hold more first.',
  BUSY: 'The agent is already working on a job.',
  PAY_FAILED: 'The job couldn’t be completed.',
}

export class JobError extends Error {
  readonly code: JobErrorCode
  /** What the agent compared before it gave up, when it got that far. */
  readonly compared: Compared[]

  /** `why` is the planner's own sentence, which says more than the stock one. */
  constructor(code: JobErrorCode, why?: string, compared: Compared[] = []) {
    super(why ?? MESSAGES[code])
    this.name = 'JobError'
    this.code = code
    this.compared = compared
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
  /** One sentence per seller the agent passed over, shown above the card. Absent when there are none. */
  notices?: string[]
  /** What the delivery check found. Absent when Arkiv is off. */
  delivery?: string
  /** One line on why this seller, e.g. "Picked from 134 Arc listings: best match for 'payment', 0.0001 USDC". Absent for a scene plan. */
  why?: string
  /** The top listings the agent compared, the picked one first. Absent for a scene plan. */
  compared?: Compared[]
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
  demo: 'a' | 'b' | 'compare' | 'd' | 'e' | 'f' | null
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

export function describeAnswer(data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  if (!text) return 'Done.'
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text
}

export interface JobOptions {
  /** Reads a seller from Arkiv before the approval card. Absent when Arkiv is off. */
  sellerCheck?: SellerCheck
  /** Only for a listing that seals: whether its deposit covers the price. Null for one that does not seal. */
  coverage?: (candidate: Candidate) => Promise<boolean | null>
  /** The network the agent's payments settle on, by name. */
  networkName?: string
  /** The most the agent may spend on one job, in atomic USDC units. */
  limit?: bigint
  /** The plan for the Seller C scene. It is ours, so it never comes from the catalog. */
  sellerCPlan?: Plan
}

// Each seller read costs a call, so a catalog full of them cannot keep the screen waiting.
const MAX_SELLERS_CHECKED = 5
const SCENE_JOB = 'Give me one short answer.'
export const DEFAULT_NETWORK_NAME = 'Arc Testnet'
/** 0.01 USDC: the most one job may cost unless the caller says otherwise. */
export const DEFAULT_JOB_LIMIT = 10_000n

/** The line above the card for a seller that was not paid: the check's own reason (ruled against, unreadable, no delivery). */
const skipNotice = (seller: string, line: string) => `${seller}: ${line}`

/** One seller name and one address it is paid at, as a catalog listing names them. */
const pairOf = (candidate: Candidate) => `${candidate.sellerName}\n${candidate.payTo?.toLowerCase() ?? ''}`

/** What the checks found, by seller name. A name is stopped when any address it is listed under is stopped. */
export interface Signals {
  signals: Map<string, SellerSignal>
  lines: Map<string, string>
  /** The name and address pairs Arkiv was read for. */
  checked: Set<string>
  /** The name and address pairs of sealing sellers whose deposit the contract said covers the price. */
  covered: Set<string>
}

async function readOne(
  candidate: Candidate,
  found: Signals,
  sellerCheck: SellerCheck | undefined,
  coverage: ((candidate: Candidate) => Promise<boolean | null>) | undefined,
): Promise<void> {
  const name = candidate.sellerName
  found.checked.add(pairOf(candidate))
  const [check, covered] = await Promise.all([
    // The address the listing names goes with the name, so a ruling against that address stops it.
    sellerCheck ? sellerCheck(name, candidate.payTo) : Promise.resolve(null),
    coverage && candidate.sealedBy ? coverage(candidate).catch(() => null) : Promise.resolve(null),
  ])
  if (covered === true) found.covered.add(pairOf(candidate))
  const before = found.signals.get(name)
  // A stop is never undone by a later read of the same name under another address.
  if (before?.delivery === 'expired') return
  found.signals.set(name, { ...(check ? { delivery: check.kind } : {}), covered: covered ?? before?.covered ?? null })
  if (check) found.lines.set(name, check.line)
}

/**
 * Reads what Arkiv and the deposit contract say about the sellers the ranking would reach, at most
 * MAX_SELLERS_CHECKED name and address pairs, so the second ranking can skip a seller that stopped
 * delivering or that Arc ruled against.
 */
export async function readSignals(
  ranked: { candidate: Candidate; blocked: string | null }[],
  sellerCheck: SellerCheck | undefined,
  coverage: ((candidate: Candidate) => Promise<boolean | null>) | undefined,
): Promise<Signals> {
  const found: Signals = { signals: new Map(), lines: new Map(), checked: new Set(), covered: new Set() }
  if (!sellerCheck && !coverage) return found
  const pairs = new Map<string, Candidate>()
  for (const r of ranked) {
    if (pairs.size >= MAX_SELLERS_CHECKED) break
    if (r.blocked === null && !pairs.has(pairOf(r.candidate))) pairs.set(pairOf(r.candidate), r.candidate)
  }
  // One read at a time per name, so two addresses of one name cannot race each other.
  const byName = new Map<string, Candidate[]>()
  for (const candidate of pairs.values()) byName.set(candidate.sellerName, [...(byName.get(candidate.sellerName) ?? []), candidate])
  await Promise.all(
    [...byName.values()].map(async (list) => {
      for (const candidate of list) await readOne(candidate, found, sellerCheck, coverage)
    }),
  )
  return found
}

export interface ChooseDeps {
  latestReceipt: () => Promise<LatestReceipt | null>
  sellerCheck?: SellerCheck
  coverage?: (candidate: Candidate) => Promise<boolean | null>
  networkName: string
  limit: bigint
}

export interface Chosen {
  plan: Plan
  /** One sentence per seller passed over because Arkiv says it stopped delivering. */
  notices: string[]
  /** What the delivery check found for the picked seller. */
  delivery: string | null
  /** True only when the pick seals and the contract said its deposit covers the price, for the address it lists. */
  protectedOnArc: boolean
}

/**
 * The agent's choice for one job: rank the whole catalog, read Arkiv and the deposit for the front
 * runners, rank again with that, and read the latest payment only when the pick is a payment check.
 * The pick itself is always read, by its name and the address it lists, before it is offered: a pick
 * below the front runners is read, and the ranking runs again when that read stops it.
 * Throws a JobError with the planner's own sentence when it will not pay anyone.
 */
export async function choosePlan(job: string, candidates: Candidate[], deps: ChooseDeps): Promise<Chosen> {
  if (!job.trim()) throw new JobError('EMPTY_JOB')
  const ctx = { networkName: deps.networkName, limit: deps.limit }

  const first = rankJob(job, candidates, ctx)
  const found = await readSignals(first.ranked, deps.sellerCheck, deps.coverage)
  const { signals, lines } = found

  let ranking = signals.size > 0 ? rankJob(job, candidates, { ...ctx, signals }) : first
  for (let extra = 0; deps.sellerCheck && ranking.pick && !found.checked.has(pairOf(ranking.pick.candidate)); extra++) {
    // Fail closed: a pick that was never read is never offered.
    if (extra >= MAX_SELLERS_CHECKED) throw new JobError('NO_SELLER')
    await readOne(ranking.pick.candidate, found, deps.sellerCheck, deps.coverage)
    ranking = rankJob(job, candidates, { ...ctx, signals })
  }

  const latest = needsLatestPayment(ranking) ? await deps.latestReceipt() : null
  const outcome = decide(job, ranking, latest)
  if (!outcome.ok) throw new JobError(outcome.reason, outcome.why, outcome.compared)

  // A seller Arkiv stopped, that words and price alone would have put first, is named above the card with the check's own reason.
  const pickAt = first.ranked.findIndex((r) => r.candidate === ranking.pick?.candidate)
  const notices = first.ranked
    .slice(0, pickAt < 0 ? first.ranked.length : pickAt)
    .filter((r) => signals.get(r.candidate.sellerName)?.delivery === 'expired')
    .map((r) => skipNotice(r.candidate.sellerName, lines.get(r.candidate.sellerName) ?? NOT_PAID))
  const pick = ranking.pick?.candidate
  return {
    plan: outcome.plan,
    notices: [...new Set(notices)],
    delivery: lines.get(outcome.plan.sellerName) ?? null,
    protectedOnArc: !!pick?.sealedBy && found.covered.has(pairOf(pick)),
  }
}

export function createJobService(
  ports: JobPorts,
  receipts: ReceiptStore,
  now: () => number = Date.now,
  { sellerCheck, sellerCPlan, coverage, networkName = DEFAULT_NETWORK_NAME, limit = DEFAULT_JOB_LIMIT }: JobOptions = {},
) {
  const plans = new Map<string, Stored>()
  let busy = false

  function sweep() {
    for (const [id, stored] of plans) if (stored.expiresAt <= now()) plans.delete(id)
  }

  async function plan(job: string): Promise<PlanView> {
    sweep()
    const chosen = await choosePlan(job, listings(await ports.candidates()), {
      latestReceipt: ports.latestReceipt,
      sellerCheck,
      coverage,
      networkName,
      limit,
    })
    return present(chosen.plan, chosen.notices, chosen.delivery)
  }

  // Only the scene may buy from Seller C, and nothing in the catalog may pass as it.
  const listings = (candidates: Candidate[]) => candidates.filter((c) => c.sellerName !== SELLER_C_NAME)

  /** The Seller C scene: plans, reads the chosen seller, and moves on while the answer is "do not pay". */
  async function firstDeliverable(
    candidates: Candidate[],
    notices: string[],
    next: (pool: Candidate[]) => PlanOutcome,
  ): Promise<PlanView> {
    let pool = candidates
    for (let checked = 0; checked < MAX_SELLERS_CHECKED; checked++) {
      const outcome = next(pool)
      if (!outcome.ok) throw new JobError(outcome.reason)
      // The listing's own address goes with the name, so a ruling against it stops this seller too.
      const listed = pool.find((c) => c.sellerName === outcome.plan.sellerName && c.resource === outcome.plan.request.url)
      const check = sellerCheck ? await sellerCheck(outcome.plan.sellerName, listed?.payTo ?? null) : null
      if (check?.kind !== 'expired') return present(outcome.plan, notices, check?.line ?? null)
      notices.push(skipNotice(outcome.plan.sellerName, check.line))
      const skipped = outcome.plan.sellerName
      pool = pool.filter((c) => c.sellerName !== skipped)
    }
    throw new JobError('NO_SELLER')
  }

  async function present(approved: Plan, notices: string[], delivery: string | null): Promise<PlanView> {
    const id = randomUUID()
    plans.set(id, { plan: approved, expiresAt: now() + PLAN_TTL_MS })
    return {
      id,
      sellerName: approved.sellerName,
      summary: approved.summary,
      amount: formatUsdc(approved.amount),
      covered: (await ports.holdAvailable()) >= approved.amount,
      ...(notices.length > 0 ? { notices } : {}),
      ...(delivery ? { delivery } : {}),
      ...(approved.why ? { why: approved.why } : {}),
      ...(approved.compared?.length ? { compared: approved.compared } : {}),
    }
  }

  /** The normal flow, with Seller C as the first candidate and the cheapest Discovery listing next. */
  async function planSellerScene(): Promise<PlanView> {
    sweep()
    if (!sellerCPlan || !sellerCheck) throw new JobError('NO_SELLER')
    const first = await sellerCheck(sellerCPlan.sellerName)
    if (first.kind !== 'expired') return present(sellerCPlan, [], first.line)
    return firstDeliverable(listings(await ports.candidates()), [skipNotice(sellerCPlan.sellerName, first.line)], (pool) =>
      planCheapest(SCENE_JOB, pool),
    )
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

  return { plan, planSellerScene, approve, listReceipts }
}
