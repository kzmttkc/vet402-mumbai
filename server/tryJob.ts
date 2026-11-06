import { createHmac, timingSafeEqual } from 'node:crypto'
import { formatUsdc, parseUsdc } from '../src/onchain-money'
import type { SellerCheck } from './arkiv'
import type { Candidate } from './discovery'
import { choosePlan, DEFAULT_NETWORK_NAME, describeAnswer, describeReceipt, JobError } from './jobs'
import type { Chosen, JobErrorCode, PayOutcome, TransferInfo } from './jobs'
import type { OwnPurchase } from './paymentCheckSeller'
import type { Compared, LatestReceipt, Plan, PlannedRequest } from './planner'
import type { TransferStatus } from './receiptStore'

// "Ask the agent" on the public page. The agent ranks the Arc catalog for the job, shows its pick,
// and pays only after Approve, from a fixed test wallet. The browser sends the job's words, the limit the
// person chose and, to approve, the plan's id. It never sends an amount, a seller or a payee: on Approve the
// server plans again from the same words and pays only if it lands on the same seller for the same price,
// under the same limit. The person's limit can only lower the server's own.

/** One paid job every this long from the same address. */
export const JOB_IP_GAP_MS = 120_000
export const JOB_DAY_MS = 86_400_000
export const DEFAULT_JOB_DAILY_LIMIT = 40
/** 0.01 USDC: the most one public job may cost. */
export const TRY_JOB_LIMIT = 10_000n
/** An approval is good for this long after the card was shown. */
export const PLAN_TTL_MS = 10 * 60 * 1000
export const MAX_JOB_CHARS = 500
/** Plans are free, but each one reads Circle, so one address gets this many a minute. */
export const PLANS_PER_MINUTE = 10
/** A settlement check every this long from the same address, at most. */
export const STATUS_GAP_MS = 2_000
const LOOKUP_ATTEMPTS = 4
const MAX_BODY_CHARS = 4_000

export type TryJobCode = 'RESTING' | 'RATE' | 'DAILY' | 'BUSY' | 'BAD_REQUEST' | 'EXPIRED' | 'UNREACHABLE' | 'PAY_FAILED' | 'NOT_FOUND'

export const TRY_JOB_MESSAGES: Record<TryJobCode, string> = {
  RESTING: 'The agent is resting for now. Watch the video instead.',
  RATE: 'Too many tries from the same place. Please wait a minute or two.',
  DAILY: "Today's paid jobs are used up. Watch the video instead.",
  BUSY: 'The agent is finishing another job. Please try again in a moment.',
  BAD_REQUEST: 'Describe the job in plain words, up to 500 characters.',
  EXPIRED: 'That plan changed or expired. Ask again.',
  UNREACHABLE: 'The agent could not reach the catalog just now. Please try again in a minute.',
  PAY_FAILED: 'The job couldn’t be completed. Nothing more will be tried.',
  NOT_FOUND: 'That payment is not one of the agent’s.',
}

/** On the card, only for a pick that seals and whose deposit the contract says covers the price. */
export const PROTECTED_LINE = "Protected on Arc: if the answer goes missing, the seller's deposit pays you back."

/** On every card, under the question: the most one job may cost, from the limit the agent actually keeps to. */
export const limitLine = (limit: bigint) => `Each job can spend at most ${formatUsdc(limit)} USDC.`

/** When the seller that fits best asks more than the person allowed. The agent does not fall back to a weaker match. */
export const overYourLimit = (limit: bigint) => `Over your limit of ${formatUsdc(limit)} USDC. Nothing was paid.`
/** The compared row of that seller. */
export const OVER_YOUR_LIMIT_NOTE = 'Over your limit'

const LIMIT_TEXT = /^\d{1,6}(\.\d{1,6})?$/

/**
 * The person's limit for one job, from the browser, never above `serverLimit`. A missing one is the server's own,
 * so an older page keeps working. Null when it is not a positive USDC amount.
 */
export function cleanLimit(value: unknown, serverLimit: bigint): bigint | null {
  if (value === undefined || value === null) return serverLimit
  if (typeof value !== 'string' || !LIMIT_TEXT.test(value.trim())) return null
  const asked = parseUsdc(value.trim())
  if (asked <= 0n) return null
  return asked < serverLimit ? asked : serverLimit
}

export const TRY_JOB_STATUS: Record<TryJobCode, number> = {
  RESTING: 503,
  RATE: 429,
  DAILY: 429,
  BUSY: 409,
  BAD_REQUEST: 400,
  EXPIRED: 409,
  UNREACHABLE: 503,
  PAY_FAILED: 502,
  NOT_FOUND: 404,
}

/** Everything a public job needs from the outside. The real one is in tryJobWire.ts, the tests pass fakes. */
export interface TryJobPorts {
  candidates(): Promise<Candidate[]>
  /** The newest payment from the agent's wallet, or null when there is none. */
  latestReceipt(): Promise<LatestReceipt | null>
  holdAvailable(): Promise<bigint>
  /** Pays the seller from the wallet and returns its answer. Must refuse to pay more than `cap`. */
  pay(request: PlannedRequest, cap: bigint): Promise<PayOutcome>
  findTransfer(nonce: string, attempts?: number): Promise<TransferInfo | null>
  /** One transfer, or null when it is not a payment from the agent's own wallet. */
  ownTransfer(id: string): Promise<TransferInfo | null>
  /** When each payment from the agent's wallet was made, in ms, from Circle's record. Shared by every instance. */
  recentPayments(): Promise<number[]>
  sellerCheck?: SellerCheck
  coverage?: (candidate: Candidate) => Promise<boolean | null>
  /** vet402's own sellers, ranked beside the catalog and bought from vet402 itself. Absent without their keys. */
  ownSellers?: OwnSeller[]
  log?: (message: string) => void
}

/** One of vet402's own sellers. `summary` is the card's sentence for it, when it has its own. */
export interface OwnSeller {
  candidate: Candidate
  summary?: string
  /** `lineDropped` keeps the key off the connection, so the answer has to come through Arc. */
  buy(cap: bigint, options?: { lineDropped?: boolean }): Promise<OwnPurchase>
}

export interface TryJobOptions {
  /** Signs plan ids. Server-side only. */
  secret: string | Uint8Array
  now?: () => number
  dailyLimit?: number
  limit?: bigint
  networkName?: string
}

export interface TryPlanView {
  /** Send this back to approve. It names nothing: it is a signature over the time, the words, the pick and the limit. */
  id: string
  sellerName: string
  summary: string
  /** USDC, as a decimal string. */
  amount: string
  why?: string
  compared: Compared[]
  notices?: string[]
  delivery?: string
  /** PROTECTED_LINE, when the pick seals and its deposit covers the price. */
  protection?: string
  /** limitLine of the limit this agent keeps to. */
  limitLine: string
  /** True when the pick is vet402's own seller, not a Discovery listing. */
  own?: boolean
  /** False when the agent's test wallet cannot cover the price right now. */
  covered: boolean
}

export type PlanReply =
  | { ok: true; plan: TryPlanView }
  | { ok: false; code: JobErrorCode; message: string; compared: Compared[] }

export interface PaidReply {
  ok: true
  sellerName: string
  text: string
  /** USDC actually paid, as a decimal string. */
  paid: string
  transferId: string | null
  status: TransferStatus | null
  batchTx: string | null
  /** The receipt's lines for a sealed answer. Technical ones start with "Detail: ". */
  lines?: string[]
}

export type Reply<T> = { ok: true; value: T } | { ok: false; code: TryJobCode }

/** Reads TRY_JOB_DAILY_LIMIT. Anything that is not a positive whole number gives the default. */
export function parseJobDailyLimit(value: string | undefined): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_JOB_DAILY_LIMIT
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLAN_ID = /^(\d{10,16})\.([0-9a-f]{64})$/

const messageOf = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : String(error))

/** A job's words as the agent reads them, or null when they are not usable. */
export function cleanJob(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const job = value.trim()
  return job.length > 0 && job.length <= MAX_JOB_CHARS ? job : null
}

export function createTryJob(ports: TryJobPorts, options: TryJobOptions) {
  const now = options.now ?? Date.now
  const dailyLimit = options.dailyLimit ?? DEFAULT_JOB_DAILY_LIMIT
  const limit = options.limit ?? TRY_JOB_LIMIT
  const networkName = options.networkName ?? DEFAULT_NETWORK_NAME
  const log = ports.log ?? ((message: string) => console.error(message))

  // These live in one instance only. The shared daily limit comes from Circle's record.
  let busy = false
  const lastByIp = new Map<string, number>()
  const statusByIp = new Map<string, number>()
  const plansByIp = new Map<string, number[]>()

  function planAllowed(ip: string): boolean {
    const at = now()
    for (const [key, times] of plansByIp) {
      const recent = times.filter((t) => at - t < 60_000)
      if (recent.length) plansByIp.set(key, recent)
      else plansByIp.delete(key)
    }
    const mine = plansByIp.get(ip) ?? []
    if (mine.length >= PLANS_PER_MINUTE) return false
    plansByIp.set(ip, [...mine, at])
    return true
  }
  const paidAt: number[] = []

  // The person's limit is signed with the pick, so an approval cannot raise it.
  const sign = (issuedAt: number, job: string, plan: Plan, cap: bigint) =>
    createHmac('sha256', options.secret)
      .update(
        ['v2', issuedAt, job, plan.kind, plan.sellerName, plan.request.method, plan.request.url, plan.amount.toString(), cap.toString()].join('\n'),
      )
      .digest('hex')

  // vet402's own sellers go beside the catalog. Only they may carry their names, so no listing can pass as one.
  const owns = ports.ownSellers ?? []
  const ownNames = new Set(owns.map((o) => o.candidate.sellerName))
  const pool = async (): Promise<Candidate[]> => {
    const listed = (await ports.candidates()).filter((c) => !c.own && !ownNames.has(c.sellerName))
    return [...listed, ...owns.map((o) => o.candidate)]
  }
  /** The own seller a plan names, by its name and its resource. */
  const ownFor = (plan: Plan) =>
    plan.own ? owns.find((o) => o.candidate.sellerName === plan.sellerName && o.candidate.resource === plan.request.url) : undefined

  const choose = async (job: string): Promise<Chosen> =>
    choosePlan(job, await pool(), {
      latestReceipt: () => ports.latestReceipt(),
      sellerCheck: ports.sellerCheck,
      coverage: ports.coverage,
      networkName,
      limit,
    })

  /**
   * Ranks the catalog for the job. Nothing is paid here. The ranking keeps to the server's limit, as before, and a pick
   * over the person's own limit is refused rather than swapped for a weaker match.
   */
  async function plan(rawJob: unknown, ip = 'unknown', rawLimit?: unknown): Promise<Reply<PlanReply>> {
    const job = cleanJob(rawJob)
    const cap = cleanLimit(rawLimit, limit)
    if (!job || cap === null) return { ok: false, code: 'BAD_REQUEST' }
    if (!planAllowed(ip)) return { ok: false, code: 'RATE' }
    let chosen: Chosen
    try {
      chosen = await choose(job)
    } catch (error) {
      if (error instanceof JobError) {
        return { ok: true, value: { ok: false, code: error.code, message: error.message, compared: error.compared } }
      }
      log(`try-job plan failed: ${messageOf(error)}`)
      return { ok: false, code: 'UNREACHABLE' }
    }
    const { plan: picked } = chosen
    if (picked.amount > cap) {
      const compared = (picked.compared ?? []).map((c) => (c.note === 'Picked' ? { ...c, note: OVER_YOUR_LIMIT_NOTE } : c))
      return { ok: true, value: { ok: false, code: 'OVER_LIMIT', message: overYourLimit(cap), compared } }
    }
    const issuedAt = now()
    let covered = false
    try {
      covered = (await ports.holdAvailable()) >= chosen.plan.amount
    } catch (error) {
      log(`try-job balance read failed: ${messageOf(error)}`)
    }
    return {
      ok: true,
      value: {
        ok: true,
        plan: {
          id: `${issuedAt}.${sign(issuedAt, job, picked, cap)}`,
          sellerName: picked.sellerName,
          summary: ownFor(picked)?.summary ?? picked.summary,
          amount: formatUsdc(picked.amount),
          ...(picked.why ? { why: picked.why } : {}),
          compared: picked.compared ?? [],
          ...(chosen.notices.length ? { notices: chosen.notices } : {}),
          ...(chosen.delivery ? { delivery: chosen.delivery } : {}),
          ...(chosen.protectedOnArc ? { protection: PROTECTED_LINE } : {}),
          limitLine: limitLine(cap),
          ...(picked.own ? { own: true } : {}),
          covered,
        },
      },
    }
  }

  /** Every check before anything is paid. On success the lock is held until `release`. */
  async function admit(ip: string): Promise<TryJobCode | null> {
    if (busy) return 'BUSY'
    const at = now()
    for (const [key, time] of lastByIp) if (at - time >= JOB_IP_GAP_MS) lastByIp.delete(key)
    if (lastByIp.has(ip)) return 'RATE'
    while (paidAt.length > 0 && at - (paidAt[0] as number) >= JOB_DAY_MS) paidAt.shift()
    if (paidAt.length >= dailyLimit) return 'DAILY'
    busy = true
    try {
      const times = await ports.recentPayments()
      const t = now()
      if (Math.max(times.filter((time) => t - time < JOB_DAY_MS).length, paidAt.length) >= dailyLimit) {
        busy = false
        return 'DAILY'
      }
    } catch (error) {
      log(`try-job record read failed: ${messageOf(error)}`)
      busy = false
      return 'UNREACHABLE'
    }
    return null
  }

  /**
   * Plans again from the same words and pays only if the pick, the price and the limit are the ones on the card.
   * `lineDropped` buys a protected vet402 seller with the key kept off the connection, so the answer comes through Arc.
   */
  async function approve(
    rawJob: unknown,
    rawId: unknown,
    ip: string,
    rawLimit?: unknown,
    { lineDropped = false }: { lineDropped?: boolean } = {},
  ): Promise<Reply<PaidReply>> {
    const job = cleanJob(rawJob)
    const id = typeof rawId === 'string' ? PLAN_ID.exec(rawId) : null
    const cap = cleanLimit(rawLimit, limit)
    if (!job || !id || cap === null) return { ok: false, code: 'BAD_REQUEST' }
    const issuedAt = Number(id[1])
    const age = now() - issuedAt
    if (!(age >= 0 && age <= PLAN_TTL_MS)) return { ok: false, code: 'EXPIRED' }

    const refused = await admit(ip)
    if (refused) return { ok: false, code: refused }
    try {
      let chosen: Chosen
      try {
        chosen = await choose(job)
      } catch (error) {
        if (error instanceof JobError) return { ok: false, code: 'EXPIRED' }
        log(`try-job replan failed: ${messageOf(error)}`)
        return { ok: false, code: 'UNREACHABLE' }
      }
      const { plan: approved } = chosen
      const expected = Buffer.from(sign(issuedAt, job, approved, cap), 'hex')
      const given = Buffer.from(id[2] as string, 'hex')
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, code: 'EXPIRED' }
      if (approved.amount > cap) return { ok: false, code: 'EXPIRED' }
      // Only vet402's own seller may sell what its plan names, and it is only planned when it is there.
      const own = ownFor(approved)
      if (approved.own && !own) return { ok: false, code: 'EXPIRED' }
      // The dropped line is only for a card with the protection line, and only with vet402's own seller.
      if (lineDropped && !(own && chosen.protectedOnArc)) return { ok: false, code: 'BAD_REQUEST' }

      if ((await ports.holdAvailable()) < approved.amount) return { ok: false, code: 'RESTING' }

      // From here a payment may happen, so this address waits its turn and the day's count goes up.
      lastByIp.set(ip, now())
      paidAt.push(now())

      let paid: PayOutcome
      let lines: string[] = []
      try {
        // The approved amount is the most the agent may spend on this job.
        if (own) {
          // vet402's own seller is bought from vet402 itself. Its resource is never fetched.
          const bought = await own.buy(approved.amount, lineDropped ? { lineDropped: true } : undefined)
          paid = bought
          lines = bought.lines
        } else {
          paid = await ports.pay(approved.request, approved.amount)
        }
      } catch (error) {
        log(`try-job payment failed: ${messageOf(error)}`)
        return { ok: false, code: 'PAY_FAILED' }
      }

      let transfer: TransferInfo | null = null
      if (paid.paid > 0n && paid.nonce) {
        try {
          transfer = await ports.findTransfer(paid.nonce, LOOKUP_ATTEMPTS)
        } catch (error) {
          // The money has moved. The screen asks again for the settlement.
          log(`try-job transfer lookup failed: ${messageOf(error)}`)
        }
      }
      if (!transfer && UUID.test(paid.transaction)) {
        transfer = { id: paid.transaction, status: 'received', txHash: null }
      }

      return {
        ok: true,
        value: {
          ok: true,
          sellerName: approved.sellerName,
          text: approved.kind === 'receipt-check' ? describeReceipt(paid.data) : describeAnswer(paid.data),
          paid: formatUsdc(paid.paid),
          transferId: transfer?.id ?? null,
          status: transfer?.status ?? null,
          batchTx: transfer?.txHash ?? null,
          ...(lines.length ? { lines } : {}),
        },
      }
    } catch (error) {
      log(`try-job approve failed: ${messageOf(error)}`)
      return { ok: false, code: 'UNREACHABLE' }
    } finally {
      busy = false
    }
  }

  /** Where one of the agent's payments stands. Only its own payments are read. */
  async function status(rawId: unknown, ip: string): Promise<Reply<{ status: TransferStatus; batchTx: string | null }>> {
    if (typeof rawId !== 'string' || !UUID.test(rawId)) return { ok: false, code: 'BAD_REQUEST' }
    const at = now()
    for (const [key, time] of statusByIp) if (at - time >= STATUS_GAP_MS) statusByIp.delete(key)
    if (statusByIp.has(ip)) return { ok: false, code: 'RATE' }
    statusByIp.set(ip, at)
    try {
      const transfer = await ports.ownTransfer(rawId)
      if (!transfer) return { ok: false, code: 'NOT_FOUND' }
      return { ok: true, value: { status: transfer.status, batchTx: transfer.txHash } }
    } catch (error) {
      log(`try-job status failed: ${messageOf(error)}`)
      return { ok: false, code: 'UNREACHABLE' }
    }
  }

  return { plan, approve, status }
}

export type TryJob = ReturnType<typeof createTryJob>

/** The address the request came from, as the platform reports it. */
export function clientIp(request: Request): string {
  const real = request.headers.get('x-real-ip')?.trim()
  if (real) return real
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || 'unknown'
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

const refuse = (code: TryJobCode) => json(TRY_JOB_STATUS[code], { code, error: TRY_JOB_MESSAGES[code] })

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_CHARS) return null
    const body = JSON.parse(text) as unknown
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The HTTP side.
 * - POST {"step":"plan","job":"...","limit":"0.005"} ranks the catalog and shows the pick. Nothing is paid.
 * - POST {"step":"approve","job":"...","id":"...","limit":"0.005"} pays the pick once. "lineDropped": true keeps the
 *   key off the connection, for a protected vet402 seller only.
 * - GET ?transfer=<id> says whether one of the agent's payments has settled.
 * Only `step`, `job`, `id`, `limit` and `lineDropped` are ever read from the body. The limit can only lower the
 * server's own, so no amount, seller or payee can come from the browser.
 */
export function createTryJobHandler(service: () => TryJob | null) {
  return async function handle(request: Request): Promise<Response> {
    const jobs = service()
    if (!jobs) return refuse('RESTING')
    const ip = clientIp(request)

    if (request.method === 'GET') {
      const transfer = new URL(request.url).searchParams.get('transfer')
      const reply = await jobs.status(transfer, ip)
      return reply.ok ? json(200, reply.value) : refuse(reply.code)
    }
    if (request.method !== 'POST') return json(405, { error: 'Use POST.' })

    const body = await readBody(request)
    if (!body) return refuse('BAD_REQUEST')
    if (body.step === 'plan') {
      const reply = await jobs.plan(body.job, ip, body.limit)
      return reply.ok ? json(200, reply.value) : refuse(reply.code)
    }
    if (body.step === 'approve') {
      const reply = await jobs.approve(body.job, body.id, ip, body.limit, { lineDropped: body.lineDropped === true })
      return reply.ok ? json(200, reply.value) : refuse(reply.code)
    }
    return refuse('BAD_REQUEST')
  }
}
