import { createDemoService } from './demo'
import type { DemoPorts, DemoSeller, StepName } from './demo'
import type { TransferInfo } from './jobs'
import type { ReceiptRow, ReceiptStore } from './receiptStore'
import type { SealedPorts } from './sealedDelivery'
import { detail, splitLines } from '../src/lib/receiptLines'

// "Try a dispute yourself": one press on the public page runs Seller A's sealed scene end to end,
// in one function call, and streams each step as it happens. The amount and the seller are fixed
// here. Nothing the browser sends is read, apart from the address it comes from.

/** One try every this long from the same address. */
export const IP_GAP_MS = 120_000
/** A payment from the hold to the try seller this recent means a try is still running somewhere. */
export const BUSY_WINDOW_MS = 45_000
export const DAY_MS = 86_400_000
export const DEFAULT_DAILY_LIMIT = 40
/** The function may run 60 s. Past this the run stops waiting for the key and says so. */
export const ANSWER_WAIT_MS = 40_000
/** The public record is written after the result, and given up this long after the start, inside the 60 s. */
export const RECORD_BY_MS = 55_000
/** The Swarm upload is waited for at most this long, and never into the last 10 s, which the transfer and the writes need. */
const EVIDENCE_WAIT_MS = 20_000
const WRITES_NEED_MS = 10_000
const STEP_POLL_MS = 100

export const EXPLORER_TX = 'https://explorer.testnet.arc.io/tx/'

export type TryErrorCode = 'BUSY' | 'RATE' | 'DAILY' | 'RESTING' | 'UNREACHABLE'

export const TRY_MESSAGES: Record<TryErrorCode, string> = {
  BUSY: 'Someone is trying it right now. Please try again in a minute.',
  RATE: 'One try every two minutes from the same place. Please wait a little.',
  DAILY: "Today's tries are used up. Watch the video instead.",
  RESTING: 'The demo is resting for now. Watch the video instead.',
  UNREACHABLE: 'The demo could not start just now. Please try again in a minute.',
}

export const TRY_STATUS: Record<TryErrorCode, number> = { BUSY: 409, RATE: 429, DAILY: 429, RESTING: 503, UNREACHABLE: 503 }

export const NO_ANSWER = 'Seller A did not answer in time. The case stays open on Arc.'

/**
 * The receipt's lines as the public screen shows them. A line that still names the key gets a plain line in its
 * place, with the same amounts, and the original goes under Details. The stored receipt is left as it was.
 */
const PLAIN_RECEIPT: [RegExp, (amount: string) => string][] = [
  [/^Charged once\. Key read from Arc\.$/, () => 'Charged once. The answer came through Arc.'],
  [
    /^The seller sent the key late and paid back the (\S+ USDC) it cost you to ask for it\.$/,
    (amount) => `The seller answered late and paid back the ${amount} it cost you to ask Arc to step in.`,
  ],
  [
    /^The seller sent the key late\. The (\S+ USDC) it cost you to ask for it is waiting for you on Arc\.$/,
    (amount) => `The seller answered late. The ${amount} it cost you to ask Arc to step in is waiting for you on Arc.`,
  ],
  [/^The seller sent the wrong key\. Arc refused it\.$/, () => 'The seller sent something that does not open the answer. Arc refused it.'],
]

const SWARM_REF = /^[0-9a-f]{64}$/i
const ENTITY_KEY = /^0x[0-9a-f]{64}$/i
const BATCH_LINE = /^Detail: Arkiv: 1 transaction, (\d+) entities$/

/**
 * The lines the public record adds after the result, from the try's own row once the writes are done. A box that
 * did not reach Swarm, or entities that did not reach Arkiv in time, add nothing.
 */
export function recordEvents(row: ReceiptRow | undefined, atMs: number): TryEvent[] {
  if (!row) return []
  const events: TryEvent[] = []
  const ref = row.evidence?.swarmRef
  if (ref && SWARM_REF.test(ref)) events.push({ type: 'record', what: 'swarm', ref, atMs })
  const entityKey = [row.arkivEvidenceKey, row.arkivPaymentKey].find((key): key is string => !!key && ENTITY_KEY.test(key))
  if (entityKey) {
    const batch = (row.outcome ?? []).map((line) => BATCH_LINE.exec(line)).find((found) => found !== null)
    events.push({ type: 'record', what: 'arkiv', entityKey, entities: batch ? Number(batch[1]) : null, atMs })
  }
  return events
}

export function plainReceipt(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    for (const [pattern, plain] of PLAIN_RECEIPT) {
      const found = pattern.exec(line)
      if (found) return [plain(found[1] ?? ''), detail(line)]
    }
    return [line]
  })
}

/** What the screen shows for each step, in plain words. The second wait is the key request. */
export function stepLabel(name: StepName, waitingSeen: number): string {
  switch (name) {
    case 'hold':
      return 'The hold covers 0.001 USDC'
    case 'payment':
      return 'vet402 paid 0.001 USDC once'
    case 'waiting':
      return waitingSeen === 0 ? 'Seller A is sending a sealed box' : 'vet402 asks Seller A for the key'
    case 'fetching again':
      return 'vet402 asks again with the same payment'
    case 'connection dropped':
      return 'The line dropped before the key arrived'
    case 'claim':
      return 'vet402 asks Arc to step in'
    case 'key on chain':
      return 'Seller A put the key on Arc'
    case 'opened':
      return 'vet402 opened the box'
    case 'delivered':
      return 'Delivered'
  }
}

export interface TryBox {
  contract: string
  ciphertext: string
  claimId: string
  plaintextHash: string
  keyBlock: string
}

export type TryEvent =
  | { type: 'step'; name: StepName; label: string; atMs: number }
  | {
      type: 'result'
      ok: true
      lines: string[]
      claimTx: string | null
      answerTx: string | null
      box: TryBox
      totalMs: number
    }
  | { type: 'result'; ok: false; message: string; claimTx: string | null; totalMs: number }
  /** After the result: the claimed box is on Swarm under this reference. Sent only when the upload came back. */
  | { type: 'record'; what: 'swarm'; ref: string; atMs: number }
  /**
   * After the result: the try reached Arkiv. `entityKey` is the evidence entity, or the payment entity when there is no
   * evidence. `entities` is the count of the one transaction that wrote them together, or null when Arkiv took them one by one.
   */
  | { type: 'record'; what: 'arkiv'; entityKey: string; entities: number | null; atMs: number }

/** Everything a try needs from the outside. The real one is in tryDisputeWire.ts, the tests pass fakes. */
export interface TryPorts {
  /** The contract address, shown to the browser so it reads the key from Arc itself. */
  contract: string
  demo: DemoPorts & { sealed: SealedPorts }
  /** Starts Seller A and its lookout for one run. Anything it needs before the payment happens here. */
  openSeller(): Promise<{ seller: DemoSeller; close(): Promise<void> }>
  /** When each payment from the hold to the try seller was made, in ms, from Circle's record. Shared by every instance. */
  recentPayments(): Promise<number[]>
  /** False when a try would run dry part way: the hold, the seller's deposit, or what pays for the claim. */
  ready(): Promise<boolean>
  /** Runs after a try. A failure only logs. */
  afterRun?(): Promise<void>
  /**
   * Keeps the try on the public record: the receipt and evidence entities on Arkiv, beside the box the
   * claim put on Swarm. Present only when the deploy holds the Arkiv writer key. Without it nothing is written.
   */
  record?: TryRecord
  log?: (message: string) => void
}

export interface TryRecord {
  /** Puts Arkiv behind the try's own receipt store. `idle` resolves when every queued write was tried. */
  wrap(store: ReceiptStore): { store: ReceiptStore; idle(): Promise<void> }
  /** Gateway's transfer for one payment nonce, or null while Gateway does not show it yet. */
  findTransfer(nonce: string): Promise<TransferInfo | null>
}

export interface TryOptions {
  dailyLimit?: number
  answerWaitMs?: number
  recordByMs?: number
  now?: () => number
}

/** Reads TRY_DAILY_LIMIT. Anything that is not a positive whole number gives the default. */
export function parseDailyLimit(value: string | undefined): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT
}

function memoryReceipts(): ReceiptStore {
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type Admission = { ok: true; run: (emit: (event: TryEvent) => void) => Promise<void> } | { ok: false; code: TryErrorCode }

export function createTryDispute(ports: TryPorts, options: TryOptions = {}) {
  const now = options.now ?? Date.now
  const dailyLimit = options.dailyLimit ?? DEFAULT_DAILY_LIMIT
  const answerWaitMs = options.answerWaitMs ?? ANSWER_WAIT_MS
  const recordByMs = options.recordByMs ?? RECORD_BY_MS
  const log = ports.log ?? ((message: string) => console.error(message))

  /**
   * After the result: waits for the claimed box's Swarm reference, then for Gateway's transfer id, and
   * hands both to the Arkiv queue, which writes the payment, the seller and the evidence entities.
   * Everything stops at the record deadline. A failure only logs.
   */
  async function keepOnRecord(
    record: TryRecord,
    local: ReceiptStore,
    kept: { store: ReceiptStore; idle(): Promise<void> },
    claimed: boolean,
    until: number,
  ): Promise<void> {
    const first = local.list()[0]
    if (!first?.nonce) return
    const nonce = first.nonce
    const latest = () => local.list().find((row) => row.id === first.id)
    // A failed upload leaves no reference, so the wait has its own limit and the receipt is still written without it.
    const evidenceBy = Math.min(now() + EVIDENCE_WAIT_MS, until - WRITES_NEED_MS)
    while (claimed && !latest()?.evidence && now() < evidenceBy) await sleep(STEP_POLL_MS * 2)
    let transfer: TransferInfo | null = null
    while (!transfer && now() < until) {
      transfer = await record.findTransfer(nonce).catch((error: unknown) => {
        log(`try-dispute transfer lookup failed: ${messageOf(error)}`)
        return null
      })
      if (!transfer) await sleep(STEP_POLL_MS * 10)
    }
    if (!transfer) {
      log('try-dispute: Gateway did not show the transfer in time, so nothing was written to Arkiv')
      return
    }
    kept.store.update(first.id, { transferId: transfer.id, status: transfer.status, batchTx: transfer.txHash })
    const left = until - now()
    if (left > 0) await Promise.race([kept.idle(), sleep(left)])
  }

  // These live in one instance only. The shared limits come from Circle's record below.
  let busy = false
  const lastByIp = new Map<string, number>()
  const starts: number[] = []

  /** Every check before anything is paid. On success the lock is held until the run ends. */
  async function admit(ip: string): Promise<Admission> {
    if (busy) return { ok: false, code: 'BUSY' }
    const at = now()
    for (const [key, time] of lastByIp) if (at - time >= IP_GAP_MS) lastByIp.delete(key)
    if (lastByIp.has(ip)) return { ok: false, code: 'RATE' }
    while (starts.length > 0 && at - (starts[0] as number) >= DAY_MS) starts.shift()
    if (starts.length >= dailyLimit) return { ok: false, code: 'DAILY' }

    busy = true
    let code: TryErrorCode | null = null
    try {
      const times = await ports.recentPayments()
      const t = now()
      if (times.some((time) => t - time < BUSY_WINDOW_MS)) code = 'BUSY'
      else if (Math.max(times.filter((time) => t - time < DAY_MS).length, starts.length) >= dailyLimit) code = 'DAILY'
      else if (!(await ports.ready())) code = 'RESTING'
    } catch (error) {
      log(`try-dispute check failed: ${messageOf(error)}`)
      code = 'UNREACHABLE'
    }
    if (code) {
      busy = false
      return { ok: false, code }
    }
    lastByIp.set(ip, now())
    starts.push(now())
    return {
      ok: true,
      run: async (emit) => {
        try {
          await runOnce(emit)
        } finally {
          busy = false
        }
      },
    }
  }

  async function runOnce(emit: (event: TryEvent) => void): Promise<void> {
    const startedAt = now()
    const tx: { claim: string | null; answer: string | null } = { claim: null, answer: null }
    const sealed = ports.demo.sealed
    const watched: SealedPorts = {
      ...sealed,
      claim: async (box, payment) => {
        const claim = await sealed.claim(box, payment)
        tx.claim = claim.transactionHash ?? null
        return claim
      },
      readKey: async (claimId, fromBlock) => {
        const found = await sealed.readKey(claimId, fromBlock)
        if (found?.transactionHash) tx.answer = found.transactionHash
        return found
      },
    }
    const fail = (message: string) => emit({ type: 'result', ok: false, message, claimTx: tx.claim, totalMs: now() - startedAt })

    let opened: Awaited<ReturnType<TryPorts['openSeller']>>
    try {
      opened = await ports.openSeller()
    } catch (error) {
      log(`try-dispute seller failed: ${messageOf(error)}`)
      fail(TRY_MESSAGES.UNREACHABLE)
      return
    }

    const local = memoryReceipts()
    // With the writer key, every row also goes to Arkiv. Without it the try keeps its rows in memory only.
    const kept = ports.record?.wrap(local) ?? null
    try {
      const receipts = kept?.store ?? local
      // A fresh service per try, so a run that outlives its wait never blocks the next one.
      const demos = createDemoService({ ...ports.demo, sealed: watched }, { a: opened.seller, b: opened.seller }, receipts, now)
      const run = demos.start('a')
      let ended = false
      void demos.settled(run.id).then(() => {
        ended = true
      })

      let sent = 0
      let waitingSeen = 0
      const flush = () => {
        const steps = demos.get(run.id)?.steps ?? []
        for (; sent < steps.length; sent++) {
          const step = steps[sent] as (typeof steps)[number]
          emit({ type: 'step', name: step.name, label: stepLabel(step.name, waitingSeen), atMs: step.atMs })
          if (step.name === 'waiting') waitingSeen++
        }
      }
      while (!ended && now() - startedAt < answerWaitMs) {
        flush()
        await sleep(STEP_POLL_MS)
      }
      flush()

      const view = demos.get(run.id)
      const row = receipts.list()[0]
      if (!ended || view?.action === 'finalize') {
        fail(NO_ANSWER)
      } else if (view?.state === 'failed') {
        fail(view.error ?? TRY_MESSAGES.UNREACHABLE)
      } else if (row?.sealed && view?.state === 'done' && view.action === null) {
        emit({
          type: 'result',
          ok: true,
          lines: plainReceipt(row.outcome ?? []),
          claimTx: tx.claim,
          answerTx: tx.answer,
          box: {
            contract: ports.contract,
            ciphertext: row.sealed.ciphertext,
            claimId: row.sealed.claimId,
            plaintextHash: row.sealed.plaintextHash,
            keyBlock: row.sealed.keyBlock,
          },
          totalMs: now() - startedAt,
        })
      } else {
        fail(splitLines(plainReceipt(row?.outcome ?? [])).plain.join(' ') || TRY_MESSAGES.UNREACHABLE)
      }
    } catch (error) {
      log(`try-dispute run failed: ${messageOf(error)}`)
      fail(TRY_MESSAGES.UNREACHABLE)
    }
    try {
      if (ports.record && kept) {
        await keepOnRecord(ports.record, local, kept, tx.claim !== null, startedAt + recordByMs)
        for (const event of recordEvents(local.list()[0], now() - startedAt)) emit(event)
      }
    } catch (error) {
      log(`try-dispute record failed: ${messageOf(error)}`)
    } finally {
      await opened.close().catch((error: unknown) => log(`try-dispute close failed: ${messageOf(error)}`))
      await ports.afterRun?.().catch((error: unknown) => log(`try-dispute after-run failed: ${messageOf(error)}`))
    }
  }

  return { admit }
}

export type TryDispute = ReturnType<typeof createTryDispute>

/** The address the request came from, as the platform reports it. */
export function clientIp(request: Request): string {
  const real = request.headers.get('x-real-ip')?.trim()
  if (real) return real
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || 'unknown'
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

/**
 * The HTTP side. POST starts a try and streams one JSON line per event. The body is never read,
 * so the amount, the seller and the payee cannot come from the browser.
 */
export function createTryHandler(service: () => TryDispute | null) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: 'Use POST.' })
    const tries = service()
    if (!tries) return json(TRY_STATUS.RESTING, { code: 'RESTING', error: TRY_MESSAGES.RESTING })
    const admitted = await tries.admit(clientIp(request))
    if (!admitted.ok) return json(TRY_STATUS[admitted.code], { code: admitted.code, error: TRY_MESSAGES[admitted.code] })

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: TryEvent) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          } catch {
            // The browser left. The run still finishes, so the lock is released properly.
          }
        }
        await admitted.run(emit)
        try {
          controller.close()
        } catch {
          // Already closed by the browser leaving.
        }
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
    })
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : String(error))

