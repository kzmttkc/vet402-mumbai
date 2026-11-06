import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import type { DemoPorts } from '../demo'
import type { SealedBox, SealedPorts } from '../sealedDelivery'
import { DEMO_PRICE } from '../sellers'
import {
  BUSY_WINDOW_MS,
  createTryDispute,
  createTryHandler,
  DAY_MS,
  IP_GAP_MS,
  NO_ANSWER,
  parseDailyLimit,
  TRY_MESSAGES,
} from '../tryDispute'
import type { TryEvent, TryPorts, TryRecord } from '../tryDispute'
import type { ReceiptRow } from '../receiptStore'
import { recentPaymentTimes } from '../tryDisputeWire'
import { sealResponse } from '../../src/lib/sealed'
import { splitLines } from '../../src/lib/receiptLines'

// The try runs the real demo service against fakes: no chain, no Gateway, no Circle. The real
// contract is covered by scripts/try-dispute-local.ts on anvil.

const PAYER = '0xAbCdEf0000000000000000000000000000000002'
const NONCE: Hex = `0x${'d'.repeat(64)}`
const CLAIM_ID: Hex = `0x${'c'.repeat(64)}`
const CLAIM_TX: Hex = `0x${'1'.repeat(64)}`
const ANSWER_TX: Hex = `0x${'2'.repeat(64)}`
const sealed = sealResponse(JSON.stringify({ seller: 'Seller A', answer: 'Here is the answer you paid for.' }))
const box: SealedBox = {
  ciphertext: sealed.ciphertext,
  promise: {
    seller: PAYER,
    value: '1000',
    paymentNonce: NONCE,
    keyHash: sealed.keyHash,
    plaintextHash: sealed.plaintextHash,
    ciphertextHash: sealed.ciphertextHash,
    expiry: '9999999999',
    buyer: PAYER,
  },
  sellerSignature: '0x',
}

interface Setup {
  sealed?: Partial<SealedPorts>
  ready?: () => Promise<boolean>
  recent?: () => Promise<number[]>
  dailyLimit?: number
  answerWaitMs?: number
  clock?: { t: number }
  record?: TryRecord
  evidence?: DemoPorts['evidence']
}

function setup(over: Setup = {}) {
  const log = { payments: 0, claims: 0, sellersOpened: 0, sellersClosed: 0, afterRuns: 0 }
  const sealedPorts: SealedPorts = {
    coverageFor: () => Promise.resolve(true),
    readBox: () => Promise.resolve({ kind: 'box', box }),
    requestKey: () => Promise.resolve(null),
    claim: () => {
      log.claims++
      return Promise.resolve({ claimId: CLAIM_ID, deadline: 100n, fromBlock: 1n, transactionHash: CLAIM_TX })
    },
    readKey: () => Promise.resolve({ key: sealed.key, block: 7n, transactionHash: ANSWER_TX }),
    chainTime: () => Promise.resolve(50n),
    wrongKeyRejected: () => false,
    finalize: () => Promise.resolve(0n),
    prove: () => Promise.resolve(0n),
    withdraw: () => Promise.resolve(0n),
    ...over.sealed,
  }
  const demo: DemoPorts & { sealed: SealedPorts } = {
    holdAvailable: () => Promise.resolve(1_000_000n),
    growHold: () => Promise.resolve(),
    prepare: () => {
      log.payments++
      return Promise.resolve({
        accept: { scheme: 'exact', network: 'eip155:5042002', amount: '1000', asset: '0x', payTo: PAYER, extra: { recovery: 'same-payment' } },
        amount: DEMO_PRICE,
        nonce: NONCE,
        payer: PAYER,
        header: { name: 'PAYMENT-SIGNATURE', value: 'h' },
        send: () => Promise.resolve(new Response('{"sealed":{}}')),
      })
    },
    confirmOnePayment: () => Promise.resolve(true),
    countPayments: () => Promise.resolve(0),
    sealed: sealedPorts,
    sealedPollMs: 1,
    ...(over.evidence ? { evidence: over.evidence } : {}),
  }
  const ports: TryPorts = {
    ...(over.record ? { record: over.record } : {}),
    contract: '0x00000000000000000000000000000000000000c0',
    demo,
    openSeller: () => {
      log.sellersOpened++
      return Promise.resolve({
        seller: { name: 'Seller A', url: 'http://s/a', address: PAYER },
        close: () => {
          log.sellersClosed++
          return Promise.resolve()
        },
      })
    },
    recentPayments: over.recent ?? (() => Promise.resolve([])),
    ready: over.ready ?? (() => Promise.resolve(true)),
    afterRun: () => {
      log.afterRuns++
      return Promise.resolve()
    },
    log: () => {},
  }
  const clock = over.clock
  const tries = createTryDispute(ports, {
    dailyLimit: over.dailyLimit ?? 40,
    answerWaitMs: over.answerWaitMs ?? 5000,
    ...(clock ? { now: () => clock.t } : {}),
  })
  return { tries, log }
}

async function runTry(tries: ReturnType<typeof setup>['tries'], ip = '1.1.1.1') {
  const admitted = await tries.admit(ip)
  if (!admitted.ok) return { code: admitted.code, events: [] as TryEvent[] }
  const events: TryEvent[] = []
  await admitted.run((event) => events.push(event))
  return { code: null, events }
}

const resultOf = (events: TryEvent[]) => events.find((e) => e.type === 'result')

describe('try a dispute yourself', () => {
  test('success on the final contract: the claim gas the answer repaid is among the receipt lines', async () => {
    const { tries } = setup({ sealed: { claimGasRepaid: () => Promise.resolve({ amount: 5698n, sent: true }) } })
    const result = resultOf((await runTry(tries)).events)
    expect(result?.type === 'result' && result.ok ? result.lines : null).toEqual([
      'Charged once. Key read from Arc.',
      'The seller sent the key late and paid back the 0.005698 USDC it cost you to ask for it.',
      'Detail: Claim gas repaid by the seller: 0.005698 USDC.',
      'Circle record: 1 transfer for this payment.',
    ])
  })

  test('the try reads in plain words: no gas, contract or claim in a step or in the body of the result', async () => {
    const { tries } = setup({ sealed: { claimGasRepaid: () => Promise.resolve({ amount: 6949n, sent: true }) } })
    const { events } = await runTry(tries)
    const shown = events.flatMap((e) => (e.type === 'step' ? [e.label] : e.ok ? splitLines(e.lines).plain : [e.message]))
    expect(shown.length).toBeGreaterThan(5)
    for (const line of shown) expect(line).not.toMatch(/gas|contract|claim/i)
    expect(NO_ANSWER).not.toMatch(/gas|contract|claim/i)
  })

  test('success: every step streams, then the receipt lines, both transactions and the box', async () => {
    const { tries, log } = setup()
    const { code, events } = await runTry(tries)
    expect(code).toBeNull()
    const steps = events.filter((e) => e.type === 'step')
    expect(steps.map((s) => (s.type === 'step' ? s.name : ''))).toEqual([
      'hold', 'payment', 'waiting', 'waiting', 'fetching again', 'connection dropped', 'claim', 'key on chain', 'opened', 'delivered',
    ])
    expect(steps.map((s) => (s.type === 'step' ? s.label : ''))).toContain('vet402 asks Arc to step in')
    const result = resultOf(events)
    expect(result).toEqual({
      type: 'result',
      ok: true,
      lines: ['Charged once. Key read from Arc.', 'Circle record: 1 transfer for this payment.'],
      claimTx: CLAIM_TX,
      answerTx: ANSWER_TX,
      box: {
        contract: '0x00000000000000000000000000000000000000c0',
        ciphertext: sealed.ciphertext,
        claimId: CLAIM_ID,
        plaintextHash: sealed.plaintextHash,
        keyBlock: '7',
      },
      totalMs: expect.any(Number),
    })
    expect(log.payments).toBe(1)
    expect(log.claims).toBe(1)
    expect(log.sellersClosed).toBe(1)
    expect(log.afterRuns).toBe(1)
  })

  test('the result never carries the key itself: the browser reads it from Arc', async () => {
    const { tries } = setup()
    const { events } = await runTry(tries)
    expect(JSON.stringify(events)).not.toContain(sealed.key.slice(2))
  })

  test('seller does not answer: the run stops waiting in time and says so', async () => {
    // The chain's clock passes the deadline a little after the run stops waiting, so nothing is left polling.
    let reads = 0
    const chainTime = () => Promise.resolve(++reads > 400 ? 200n : 50n)
    const { tries, log } = setup({ sealed: { readKey: () => Promise.resolve(null), chainTime }, answerWaitMs: 300 })
    const started = Date.now()
    const { events } = await runTry(tries)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(resultOf(events)).toEqual({ type: 'result', ok: false, message: NO_ANSWER, claimTx: CLAIM_TX, totalMs: expect.any(Number) })
    expect(log.sellersClosed).toBe(1)
  })

  test('seller does not answer and the window closes: the same message, no button to press', async () => {
    const { tries } = setup({ sealed: { readKey: () => Promise.resolve(null), chainTime: () => Promise.resolve(200n) } })
    const { events } = await runTry(tries)
    expect(resultOf(events)).toMatchObject({ ok: false, message: NO_ANSWER })
  })

  test('limit: the same address waits two minutes', async () => {
    const clock = { t: 1_000_000 }
    const { tries, log } = setup({ clock })
    expect((await runTry(tries, '9.9.9.9')).code).toBeNull()
    clock.t += IP_GAP_MS - 1
    expect((await runTry(tries, '9.9.9.9')).code).toBe('RATE')
    expect((await runTry(tries, '8.8.8.8')).code).toBeNull()
    clock.t += 1
    expect((await runTry(tries, '9.9.9.9')).code).toBeNull()
    expect(log.payments).toBe(3)
  })

  test('limit: the daily cap counts this instance', async () => {
    const clock = { t: 1_000_000 }
    const { tries, log } = setup({ clock, dailyLimit: 2 })
    expect((await runTry(tries, 'a')).code).toBeNull()
    expect((await runTry(tries, 'b')).code).toBeNull()
    expect((await runTry(tries, 'c')).code).toBe('DAILY')
    clock.t += DAY_MS
    expect((await runTry(tries, 'd')).code).toBeNull()
    expect(log.payments).toBe(3)
  })

  test("limit: the daily cap counts Circle's record, which every instance shares", async () => {
    const clock = { t: 10 * DAY_MS }
    const paid = [clock.t - 60_000, clock.t - 2 * 60_000, clock.t - DAY_MS - 1]
    const { tries, log } = setup({ clock, dailyLimit: 2, recent: () => Promise.resolve(paid) })
    expect((await runTry(tries)).code).toBe('DAILY')
    expect(log.payments).toBe(0)
  })

  test('limit: TRY_DAILY_LIMIT defaults to 40', () => {
    expect(parseDailyLimit(undefined)).toBe(40)
    expect(parseDailyLimit('abc')).toBe(40)
    expect(parseDailyLimit('0')).toBe(40)
    expect(parseDailyLimit('5')).toBe(5)
  })

  test('concurrent: a second press while one runs is refused, and nothing is paid twice', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { tries, log } = setup({ ready: () => gate.then(() => true) })
    const first = runTry(tries, 'a')
    const second = await runTry(tries, 'b')
    expect(second.code).toBe('BUSY')
    release()
    expect((await first).code).toBeNull()
    expect(log.payments).toBe(1)
    // The lock is released once the run ends.
    expect((await runTry(tries, 'c')).code).toBeNull()
  })

  test("concurrent: a payment in Circle's record from moments ago means another instance is running", async () => {
    const clock = { t: 5_000_000 }
    const { tries, log } = setup({ clock, recent: () => Promise.resolve([clock.t - (BUSY_WINDOW_MS - 1)]) })
    expect((await runTry(tries)).code).toBe('BUSY')
    expect(log.payments).toBe(0)
  })

  test('low balance: the demo rests and nothing is paid', async () => {
    const { tries, log } = setup({ ready: () => Promise.resolve(false) })
    expect((await runTry(tries)).code).toBe('RESTING')
    expect(log.payments).toBe(0)
    expect(log.sellersOpened).toBe(0)
    // A refusal does not use up the address's two minutes.
    expect((await runTry(tries)).code).toBe('RESTING')
  })

  test('a check that cannot be read refuses to start, and nothing is paid', async () => {
    const { tries, log } = setup({ recent: () => Promise.reject(new Error('circle down')) })
    expect((await runTry(tries)).code).toBe('UNREACHABLE')
    expect(log.payments).toBe(0)
  })
})

describe('the HTTP side', () => {
  const read = async (res: Response) =>
    (await res.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TryEvent)

  test('POST streams one JSON line per event', async () => {
    const { tries } = setup()
    const res = await createTryHandler(() => tries)(new Request('http://x/api/try-dispute', { method: 'POST' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    const events = await read(res)
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: true })
  })

  test('an amount or a payee in the body is never read', async () => {
    const { tries, log } = setup()
    const body = JSON.stringify({ amount: '100', payTo: '0x000000000000000000000000000000000000dEaD' })
    const res = await createTryHandler(() => tries)(new Request('http://x/api/try-dispute', { method: 'POST', body }))
    await read(res)
    expect(log.payments).toBe(1)
  })

  test('limit refusals come back with a status and the sentence', async () => {
    const { tries } = setup({ ready: () => Promise.resolve(false) })
    const res = await createTryHandler(() => tries)(new Request('http://x/api/try-dispute', { method: 'POST' }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'RESTING', error: 'The demo is resting for now. Watch the video instead.' })
  })

  test('the two minutes follow the forwarded address', async () => {
    const { tries } = setup()
    const handle = createTryHandler(() => tries)
    const from = (ip: string) => new Request('http://x/api/try-dispute', { method: 'POST', headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } })
    await read(await handle(from('7.7.7.7')))
    expect((await handle(from('7.7.7.7'))).status).toBe(429)
    expect((await handle(from('6.6.6.6'))).status).toBe(200)
  })

  test('with no keys configured the demo rests', async () => {
    const res = await createTryHandler(() => null)(new Request('http://x/api/try-dispute', { method: 'POST' }))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe(TRY_MESSAGES.RESTING)
  })

  test('other methods are refused', async () => {
    const { tries, log } = setup()
    const res = await createTryHandler(() => tries)(new Request('http://x/api/try-dispute', { method: 'PUT' }))
    expect(res.status).toBe(405)
    expect(log.payments).toBe(0)
  })
})

describe("Circle's record as the shared counter", () => {
  test('reads the time of every payment from the hold to the seller', async () => {
    let asked = ''
    const fetchImpl = ((url: string) => {
      asked = url
      return Promise.resolve(
        new Response(JSON.stringify({ transfers: [{ createdAt: '2026-11-05T21:01:45.884Z' }, { createdAt: 'nonsense' }] })),
      )
    }) as typeof fetch
    const times = await recentPaymentTimes('0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2', fetchImpl)
    expect(times).toEqual([Date.parse('2026-11-05T21:01:45.884Z')])
    expect(asked).toContain('from=0x00000000000000000000000000000000000000a1&to=0x00000000000000000000000000000000000000b2')
  })
})

describe('the try on the public record', () => {
  test('with the writer key, the try hands its row to Arkiv with the transfer id and the Swarm reference', async () => {
    const seen: ReceiptRow[][] = []
    const lookups: string[] = []
    const record: TryRecord = {
      wrap(store) {
        return {
          store: {
            list: () => store.list(),
            add: (row) => store.add(row),
            update: (id, patch) => {
              store.update(id, patch)
              seen.push(store.list().map((r) => ({ ...r })))
            },
          },
          idle: () => Promise.resolve(),
        }
      },
      findTransfer: (nonce) => {
        lookups.push(nonce)
        return Promise.resolve(lookups.length < 2 ? null : { id: 'transfer-1', status: 'received', txHash: null })
      },
    }
    const { tries } = setup({ record, evidence: () => Promise.resolve('ab'.repeat(32)) })
    const { events } = await runTry(tries)
    expect(resultOf(events)?.type === 'result' && (resultOf(events) as { ok: boolean }).ok).toBe(true)
    expect(lookups).toEqual([NONCE, NONCE])
    const last = seen.at(-1)?.[0]
    expect(last?.transferId).toBe('transfer-1')
    expect(last?.evidence).toEqual({ claimId: CLAIM_ID, swarmRef: 'ab'.repeat(32) })
  })

  test('without the key the try runs as before and asks Gateway for nothing more', async () => {
    const { tries, log } = setup()
    const { events } = await runTry(tries)
    expect(resultOf(events)?.type).toBe('result')
    expect(log.payments).toBe(1)
  })
})
