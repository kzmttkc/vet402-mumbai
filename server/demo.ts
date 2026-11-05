import { createHash, randomUUID } from 'node:crypto'
import type { ExpectedPayment } from './circleRecord'
import type { PreparedPayment } from './gatewayPay'
import type { ReceiptRow, ReceiptStore } from './receiptStore'
import { DEMO_PRICE, RECOVERY_SAME_PAYMENT } from './sellers'
import { parseUsdc } from '../src/onchain-money'

/** The comparison makes the hold this much larger, so it never eats into the hold for a real job. */
export const COMPARISON_EXTRA_HOLD = parseUsdc('0.002')

/** The Seller C scene makes the hold this much larger, so it never eats into the hold for a real job. */
export const SELLER_C_EXTRA_HOLD = parseUsdc('0.001')

export type DemoKind = 'a' | 'b' | 'compare'

export type StepName = 'hold' | 'payment' | 'waiting' | 'connection dropped' | 'fetching again' | 'delivered'

export interface DemoStep {
  name: StepName
  /** Milliseconds since the run started. */
  atMs: number
}

export interface DemoRunView {
  id: string
  kind: DemoKind
  state: 'running' | 'done' | 'failed'
  steps: DemoStep[]
  error: string | null
}

/** Everything a demo run needs from the outside world. Real versions live in demoPorts.ts. */
export interface DemoPorts {
  /** What the hold can still spend, in atomic USDC units. */
  holdAvailable(): Promise<bigint>
  /** Makes the hold bigger by `amount`, and resolves once the extra can be spent. */
  growHold(amount: bigint): Promise<void>
  /** Asks the seller for its price, runs the checks, and signs once with the hold key. */
  prepare(sellerUrl: string): Promise<PreparedPayment>
  /** Circle's record for one nonce: exactly one good transfer for this payment? */
  confirmOnePayment(nonce: string, expected: ExpectedPayment): Promise<boolean>
  /** Circle's record by payer and seller: how many of these nonces are in it. */
  countPayments(payer: string, seller: string, nonces: string[]): Promise<number>
}

export interface DemoSeller {
  name: string
  url: string
  address: string
}

export type DemoErrorCode = 'BUSY' | 'NOT_COVERED' | 'LOW_BALANCE' | 'REFUSED' | 'UNKNOWN'

const MESSAGES: Record<DemoErrorCode, string> = {
  BUSY: 'A demo is already running.',
  NOT_COVERED: 'The hold doesn’t cover this. Hold more first.',
  LOW_BALANCE: 'Your balance is too low for this.',
  REFUSED: 'The seller did not accept the payment.',
  UNKNOWN: 'The demo could not finish. Please try again.',
}

export class DemoError extends Error {
  readonly code: DemoErrorCode

  constructor(code: DemoErrorCode) {
    super(MESSAGES[code])
    this.name = 'DemoError'
    this.code = code
  }
}

const MAX_RUNS = 20
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function createDemoService(
  ports: DemoPorts,
  sellers: { a: DemoSeller; b: DemoSeller },
  receipts: ReceiptStore,
  now: () => number = Date.now,
) {
  interface Run extends DemoRunView {
    startedAt: number
  }
  const runs = new Map<string, Run>()
  const finished = new Map<string, Promise<void>>()
  let busy = false

  const mark = (run: Run, name: StepName) => run.steps.push({ name, atMs: now() - run.startedAt })

  function addRow(
    seller: DemoSeller,
    payment: PreparedPayment,
    result: { body: string; received: number; outcome: string[]; demo: DemoKind; comparison?: boolean },
  ): string {
    const row: ReceiptRow = {
      id: randomUUID(),
      at: new Date(now()).toISOString(),
      amount: payment.amount.toString(),
      sellerName: seller.name,
      responseHash: sha256(result.body),
      responseBytes: Buffer.byteLength(result.body),
      timesReceived: result.received,
      transferId: null,
      nonce: payment.nonce,
      status: 'received',
      batchTx: null,
      outcome: result.outcome,
      demo: result.demo,
      comparison: result.comparison ?? false,
    }
    receipts.add(row)
    return row.id
  }

  const expectedFor = (seller: DemoSeller, payment: PreparedPayment): ExpectedPayment => ({
    seller: seller.address,
    payer: payment.payer,
    amount: DEMO_PRICE.toString(),
  })

  /** Sends once. A dropped connection comes back as null, and it is not sent again from here. */
  async function sendOnceOrNull(payment: PreparedPayment): Promise<Response | null> {
    try {
      return await payment.send()
    } catch {
      return null
    }
  }

  async function single(run: Run, kind: 'a' | 'b') {
    const seller = sellers[kind]
    if ((await ports.holdAvailable()) < DEMO_PRICE) throw new DemoError('NOT_COVERED')
    mark(run, 'hold')

    const payment = await ports.prepare(seller.url)
    mark(run, 'payment')

    mark(run, 'waiting')
    const first = await sendOnceOrNull(payment)
    if (first) {
      if (!first.ok) throw new DemoError('REFUSED')
      const body = await first.text()
      mark(run, 'delivered')
      addRow(seller, payment, { body, received: 1, outcome: ['Charged once. Delivered.'], demo: kind })
      return
    }
    mark(run, 'connection dropped')

    // Only a seller that says "same-payment" is asked again, and then with the same payment, never a new signature.
    if (payment.accept.extra?.recovery !== RECOVERY_SAME_PAYMENT) {
      const id = addRow(seller, payment, {
        body: '',
        received: 0,
        outcome: ['Nothing delivered. No second charge.'],
        demo: kind,
      })
      if (await ports.confirmOnePayment(payment.nonce, expectedFor(seller, payment))) {
        receipts.update(id, { outcome: ['Charged once. Nothing delivered. No second charge.'] })
      }
      return
    }

    mark(run, 'fetching again')
    const second = await sendOnceOrNull(payment)
    if (!second?.ok) {
      addRow(seller, payment, {
        body: '',
        received: 0,
        outcome: ['Nothing delivered. The second fetch did not return the answer.'],
        demo: kind,
      })
      return
    }
    const body = await second.text()
    mark(run, 'delivered')
    const id = addRow(seller, payment, {
      body,
      received: 1,
      outcome: ['Charged once. Delivered on the second fetch.'],
      demo: kind,
    })

    const confirmed = await ports.confirmOnePayment(payment.nonce, expectedFor(seller, payment))
    receipts.update(id, {
      outcome: [
        'Charged once. Delivered on the second fetch.',
        confirmed ? 'Circle record: 1 transfer for this payment.' : 'Circle record: not confirmed yet.',
      ],
    })
  }

  // Comparison only: what happens when the agent signs a fresh payment instead of asking again.
  async function compare(run: Run) {
    const seller = sellers.b
    await ports.growHold(COMPARISON_EXTRA_HOLD)
    mark(run, 'hold')

    const nonces: string[] = []
    const rowIds: string[] = []
    let payer = ''

    for (let i = 0; i < 2; i++) {
      const payment = await ports.prepare(seller.url)
      mark(run, 'payment')
      nonces.push(payment.nonce)
      payer = payment.payer

      mark(run, 'waiting')
      const res = await sendOnceOrNull(payment)
      let body = ''
      if (res?.ok) {
        body = await res.text()
        mark(run, 'delivered')
      } else {
        mark(run, 'connection dropped')
      }
      rowIds.push(
        addRow(seller, payment, { body, received: body ? 1 : 0, outcome: [], demo: 'compare', comparison: true }),
      )
    }

    mark(run, 'waiting')
    const count = await ports.countPayments(payer, seller.address, nonces)
    // Only a count of exactly two says "charged twice".
    if (count === 2) {
      for (const id of rowIds) receipts.update(id, { outcome: ['Circle record: 2 transfers. Charged twice.'] })
    }
  }

  function start(kind: DemoKind): DemoRunView {
    if (busy) throw new DemoError('BUSY')
    busy = true

    const run: Run = { id: randomUUID(), kind, state: 'running', steps: [], error: null, startedAt: now() }
    runs.set(run.id, run)
    for (const id of [...runs.keys()].slice(0, Math.max(0, runs.size - MAX_RUNS))) runs.delete(id)

    finished.set(
      run.id,
      (kind === 'compare' ? compare(run) : single(run, kind))
        .then(() => {
          run.state = 'done'
        })
        .catch((error: unknown) => {
          run.state = 'failed'
          if (error instanceof DemoError) {
            run.error = error.message
          } else {
            console.error('demo failed:', error instanceof Error ? error.message : error)
            run.error = MESSAGES.UNKNOWN
          }
        })
        .finally(() => {
          busy = false
        }),
    )
    return view(run)
  }

  const view = ({ startedAt: _startedAt, ...rest }: Run): DemoRunView => ({ ...rest, steps: [...rest.steps] })

  return {
    start,
    get(id: string): DemoRunView | null {
      const run = runs.get(id)
      return run ? view(run) : null
    },
    /** Resolves when a run has ended. For tests. */
    settled: (id: string) => finished.get(id) ?? Promise.resolve(),
  }
}
