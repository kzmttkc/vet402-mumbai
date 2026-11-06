import { createHash, randomUUID } from 'node:crypto'
import { keccak256 } from 'viem'
import type { Hex } from 'viem'
import type { ExpectedPayment } from './circleRecord'
import type { PreparedPayment } from './gatewayPay'
import type { ReceiptRow, ReceiptStore, SealedRecord } from './receiptStore'
import type { SealedBox, SealedPorts } from './sealedDelivery'
import { DEMO_PRICE, RECOVERY_SAME_PAYMENT } from './sellers'
import { openResponse } from '../src/lib/sealed'
import { formatUsdc, parseUsdc } from '../src/onchain-money'

/** The comparison makes the hold this much larger, so it never eats into the hold for a real job. */
export const COMPARISON_EXTRA_HOLD = parseUsdc('0.002')

/** The Seller C scene makes the hold this much larger, so it never eats into the hold for a real job. */
export const SELLER_C_EXTRA_HOLD = parseUsdc('0.001')

export type DemoKind = 'a' | 'b' | 'compare' | 'd' | 'e' | 'f'

export type StepName =
  | 'hold'
  | 'payment'
  | 'waiting'
  | 'connection dropped'
  | 'fetching again'
  | 'claim'
  | 'key on chain'
  | 'opened'
  | 'delivered'

/** What the screen can press once the run has stopped. */
export type DemoAction = 'finalize' | 'prove' | 'withdraw'

// The receipt sentences. These are fixed wordings.
/** Only a sealed answer whose key opened it to the seller's promise gets this line. server/arkiv.ts relies on that. */
export const KEY_FROM_CHAIN = 'Charged once. Key read from Arc.'
const WRONG_KEY_REJECTED = 'Wrong key rejected by the contract.'
const silentLine = (amount: string) => `The seller stayed silent. Its deposit paid ${amount} back.`
const fraudLine = (amount: string) => `The answer did not match the seller's promise. Its deposit paid ${amount} back.`
const usdcAmount = (amount: bigint) => `${formatUsdc(amount)} USDC`

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
  /** Set when the run has stopped with a button to press. */
  action: DemoAction | null
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
  /** The contract. Without it every demo runs on the same-payment path alone. */
  sealed?: SealedPorts
  /** How long the demo waits between two reads of the chain. */
  sealedPollMs?: number
  /** Keeps the claimed box on Swarm and returns its reference. A failure only logs. */
  evidence?: (box: SealedBox, claimId: Hex) => Promise<string>
  /** Writes Arc's ruling to Arkiv once finalize or prove has gone through. It queues and never throws. */
  verdict?: (ruling: { claimId: Hex; payTo: string; verdict: 'silent' | 'fraud'; claimTx?: Hex }) => void
}

/**
 * With World ID in production the demo never adds to the hold. In place of growHold it spends from what an
 * approval already put there, and refuses when that does not cover the scene.
 */
export function fromApprovedHold(ports: Pick<DemoPorts, 'holdAvailable'>): DemoPorts['growHold'] {
  return async (amount) => {
    if ((await ports.holdAvailable()) < amount) throw new DemoError('NOT_COVERED')
  }
}

export interface DemoSeller {
  name: string
  url: string
  address: string
}

export type DemoErrorCode = 'BUSY' | 'NOT_COVERED' | 'LOW_BALANCE' | 'REFUSED' | 'UNAVAILABLE' | 'UNKNOWN'

const MESSAGES: Record<DemoErrorCode, string> = {
  BUSY: 'A demo is already running.',
  NOT_COVERED: 'The hold doesn’t cover this. Hold more first.',
  LOW_BALANCE: 'Your balance is too low for this.',
  REFUSED: 'The seller did not accept the payment.',
  UNAVAILABLE: 'This demo is not available.',
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
/** Past the deadline the chain may simply be unreachable. The wait ends this long after it. */
const CHAIN_WAIT_LIMIT_MS = 120_000
const DEFAULT_POLL_MS = 2000
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function createDemoService(
  ports: DemoPorts,
  sellers: { a: DemoSeller; b: DemoSeller; d?: DemoSeller; e?: DemoSeller; f?: DemoSeller },
  receipts: ReceiptStore,
  now: () => number = Date.now,
) {
  interface Run extends DemoRunView {
    startedAt: number
    /** What the buttons need. Never leaves this service. */
    open?: { claimId: Hex; ciphertext: Hex; key?: Hex; rowId: string; lines: string[]; payTo: string; claimTx?: Hex }
    acting?: boolean
  }
  const runs = new Map<string, Run>()
  const finished = new Map<string, Promise<void>>()
  let busy = false

  const mark = (run: Run, name: StepName) => run.steps.push({ name, atMs: now() - run.startedAt })

  /** Who a ruling on this claim is about: the address that was paid, and the claim's transaction. */
  const ruledOn = (payment: PreparedPayment, claim: { transactionHash?: Hex }) => ({
    payTo: payment.accept.payTo,
    ...(claim.transactionHash ? { claimTx: claim.transactionHash } : {}),
  })

  /** The Swarm reference, or null when there is no uploader or the upload failed. Never throws. */
  async function keepEvidence(box: SealedBox, claimId: Hex): Promise<string | null> {
    if (!ports.evidence) return null
    try {
      return await ports.evidence(box, claimId)
    } catch (error) {
      console.error('swarm upload failed:', error instanceof Error ? error.message.split('\n')[0] : error)
      return null
    }
  }

  function addRow(
    seller: DemoSeller,
    payment: PreparedPayment,
    result: { body: string; received: number; outcome: string[]; demo: DemoKind; comparison?: boolean; sealed?: SealedRecord },
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
      ...(result.sealed ? { sealed: result.sealed } : {}),
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

  /** The same ending as a seller that declares nothing: nothing more can be done, and nothing is charged twice. */
  async function nothingMore(seller: DemoSeller, payment: PreparedPayment, kind: DemoKind) {
    const id = addRow(seller, payment, {
      body: '',
      received: 0,
      outcome: ['Nothing delivered. No second charge.'],
      demo: kind,
    })
    if (await ports.confirmOnePayment(payment.nonce, expectedFor(seller, payment))) {
      receipts.update(id, { outcome: ['Charged once. Nothing delivered. No second charge.'] })
    }
  }

  /** Opens with the key. The text is null when the key or the content is not what the seller promised. */
  function open(box: SealedBox, key: Hex): { text: string; matches: boolean } | null {
    if (keccak256(key) !== box.promise.keyHash) return null
    const plain = openResponse(box.ciphertext, key)
    return {
      text: new TextDecoder().decode(plain),
      matches: keccak256(plain) === box.promise.plaintextHash,
    }
  }

  /** Reads the chain until the key is there or the deadline has passed. A failed read is just read again. */
  async function waitForKey(
    sealed: SealedPorts,
    claim: { claimId: Hex; deadline: bigint; fromBlock: bigint },
    onRejected: () => void,
  ): Promise<{ key: Hex; block: bigint } | null> {
    const pollMs = ports.sealedPollMs ?? DEFAULT_POLL_MS
    let gaveUpAt = Date.now() + CHAIN_WAIT_LIMIT_MS
    let rejected = false
    for (;;) {
      if (!rejected && sealed.wrongKeyRejected(claim.claimId)) {
        rejected = true
        onRejected()
      }
      try {
        const found = await sealed.readKey(claim.claimId, claim.fromBlock)
        if (found) return found
        if ((await sealed.chainTime()) >= claim.deadline) {
          // One more read: the key may have landed in the last block before the deadline.
          return await sealed.readKey(claim.claimId, claim.fromBlock)
        }
        gaveUpAt = Date.now() + CHAIN_WAIT_LIMIT_MS
      } catch {
        if (Date.now() > gaveUpAt) return null
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  /** A seller with a contract behind it: a sealed box, the key on a separate request, the chain if that fails. */
  async function sealedRun(run: Run, kind: 'a' | 'd' | 'e' | 'f', sealed: SealedPorts) {
    const seller = sellers[kind]
    if (!seller) throw new DemoError('UNAVAILABLE')
    if ((await ports.holdAvailable()) < DEMO_PRICE) throw new DemoError('NOT_COVERED')
    mark(run, 'hold')

    // Read before paying. A failed read counts as no cover, so it can only make the agent more careful.
    const covered = await sealed.coverageFor(seller.address, DEMO_PRICE).catch(() => false)

    const payment = await ports.prepare(seller.url)
    mark(run, 'payment')

    mark(run, 'waiting')
    let first = await sendOnceOrNull(payment)
    let boxFetchedAgain = false
    if (!first) {
      mark(run, 'connection dropped')
      if (payment.accept.extra?.recovery !== RECOVERY_SAME_PAYMENT) return nothingMore(seller, payment, kind)
      mark(run, 'fetching again')
      first = await sendOnceOrNull(payment)
      boxFetchedAgain = true
      if (!first?.ok) {
        addRow(seller, payment, {
          body: '',
          received: 0,
          outcome: ['Nothing delivered. The second fetch did not return the answer.'],
          demo: kind,
        })
        return
      }
    }
    if (!first.ok) throw new DemoError('REFUSED')
    const body = await first.text()

    const read = await sealed.readBox(body, payment)
    if (read.kind === 'bad') return nothingMore(seller, payment, kind)
    if (read.kind === 'plain') {
      mark(run, 'delivered')
      addRow(seller, payment, { body, received: 1, outcome: ['Charged once. Delivered.'], demo: kind })
      return
    }
    const { box } = read

    // The key on its own request. When that works, nothing touches the chain.
    mark(run, 'waiting')
    let offered = await sealed.requestKey(seller.url, payment)
    if (!offered) {
      // Asking again is free, so the chain is the last resort.
      mark(run, 'fetching again')
      offered = await sealed.requestKey(seller.url, payment)
    }
    const opened = offered ? open(box, offered) : null
    if (opened?.matches) {
      mark(run, 'opened')
      mark(run, 'delivered')
      addRow(seller, payment, {
        body: opened.text,
        received: 1,
        outcome: [boxFetchedAgain ? 'Charged once. Delivered on the second fetch.' : 'Charged once. Delivered.'],
        demo: kind,
      })
      return
    }
    mark(run, 'connection dropped')
    if (!covered) return nothingMore(seller, payment, kind)

    mark(run, 'claim')
    let claim: Awaited<ReturnType<SealedPorts['claim']>>
    try {
      claim = await sealed.claim(box, payment)
    } catch (error) {
      console.error('claim failed:', error instanceof Error ? error.message.split('\n')[0] : error)
      await nothingMore(seller, payment, kind)
      throw new DemoError('UNKNOWN')
    }
    // The upload runs beside the wait for the key and never holds up the claim or the payment.
    const evidence = keepEvidence(box, claim.claimId)
    const attach = (rowId: string) =>
      void evidence.then((swarmRef) => {
        if (swarmRef) receipts.update(rowId, { evidence: { claimId: claim.claimId, swarmRef } })
      })

    const lines: string[] = []
    const found = await waitForKey(sealed, claim, () => lines.push(WRONG_KEY_REJECTED))

    if (!found) {
      // The deadline passed with no key. Anyone can press finalize now.
      const rowId = addRow(seller, payment, { body: '', received: 0, outcome: lines, demo: kind })
      attach(rowId)
      run.open = { claimId: claim.claimId, ciphertext: box.ciphertext, rowId, lines, ...ruledOn(payment, claim) }
      run.action = 'finalize'
      return
    }

    mark(run, 'key on chain')
    const result = open(box, found.key)
    mark(run, 'opened')
    const record: SealedRecord = {
      ciphertext: box.ciphertext,
      claimId: claim.claimId,
      plaintextHash: box.promise.plaintextHash,
      keyBlock: found.block.toString(),
    }

    if (!result?.matches) {
      const rowId = addRow(seller, payment, {
        body: result?.text ?? '',
        received: 1,
        outcome: lines,
        demo: kind,
        sealed: record,
      })
      attach(rowId)
      run.open = { claimId: claim.claimId, ciphertext: box.ciphertext, key: found.key, rowId, lines, ...ruledOn(payment, claim) }
      run.action = 'prove'
      return
    }

    mark(run, 'delivered')
    const id = addRow(seller, payment, {
      body: result.text,
      received: 1,
      outcome: [...lines, KEY_FROM_CHAIN],
      demo: kind,
      sealed: record,
    })
    attach(id)
    const confirmed = await ports.confirmOnePayment(payment.nonce, expectedFor(seller, payment))
    receipts.update(id, {
      outcome: [
        ...lines,
        KEY_FROM_CHAIN,
        confirmed ? 'Circle record: 1 transfer for this payment.' : 'Circle record: not confirmed yet.',
      ],
    })
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

  function work(run: Run, kind: DemoKind): Promise<void> {
    if (kind === 'compare') return compare(run)
    if (kind === 'b') return single(run, kind)
    return ports.sealed ? sealedRun(run, kind, ports.sealed) : kind === 'a' ? single(run, kind) : Promise.reject(new DemoError('UNAVAILABLE'))
  }

  /** One press of a button on a stopped run. The run keeps its button if the press fails, so it can be pressed again. */
  async function act(id: string, action: DemoAction): Promise<DemoRunView> {
    const run = runs.get(id)
    const sealed = ports.sealed
    if (!run || !sealed || run.action !== action || !run.open || run.acting) throw new DemoError('UNAVAILABLE')
    const opened = run.open
    run.acting = true
    try {
      if (action === 'withdraw') {
        await sealed.withdraw()
        run.action = null
      } else {
        const paid =
          action === 'finalize'
            ? await sealed.finalize(opened.claimId)
            : await sealed.prove(opened.claimId, opened.ciphertext, opened.key as Hex)
        // finalize and prove only return once the contract emitted Silent or Fraud, so this is Arc's ruling.
        try {
          ports.verdict?.({
            claimId: opened.claimId,
            payTo: opened.payTo,
            verdict: action === 'finalize' ? 'silent' : 'fraud',
            ...(opened.claimTx ? { claimTx: opened.claimTx } : {}),
          })
        } catch (error) {
          console.error('verdict write failed:', error instanceof Error ? error.message.split('\n')[0] : error)
        }
        const line = paid > 0n ? (action === 'finalize' ? silentLine : fraudLine)(usdcAmount(paid)) : 'Nothing delivered. No second charge.'
        opened.lines.push(line)
        receipts.update(opened.rowId, { outcome: [...opened.lines] })
        run.action = paid > 0n ? 'withdraw' : null
      }
      return view(run)
    } catch (error) {
      console.error(`${action} failed:`, error instanceof Error ? error.message.split('\n')[0] : error)
      throw new DemoError('UNKNOWN')
    } finally {
      run.acting = false
    }
  }

  function start(kind: DemoKind): DemoRunView {
    if (busy) throw new DemoError('BUSY')
    busy = true

    const run: Run = { id: randomUUID(), kind, state: 'running', steps: [], error: null, action: null, startedAt: now() }
    runs.set(run.id, run)
    for (const id of [...runs.keys()].slice(0, Math.max(0, runs.size - MAX_RUNS))) runs.delete(id)

    finished.set(
      run.id,
      work(run, kind)
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

  const view = ({ startedAt: _startedAt, open: _open, acting: _acting, ...rest }: Run): DemoRunView => ({
    ...rest,
    steps: [...rest.steps],
  })

  return {
    start,
    act,
    get(id: string): DemoRunView | null {
      const run = runs.get(id)
      return run ? view(run) : null
    },
    /** Resolves when a run has ended. For tests. */
    settled: (id: string) => finished.get(id) ?? Promise.resolve(),
  }
}
