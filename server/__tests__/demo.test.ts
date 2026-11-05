import { describe, expect, test } from 'bun:test'
import { COMPARISON_EXTRA_HOLD, createDemoService, DemoError } from '../demo'
import type { DemoPorts, DemoSeller } from '../demo'
import type { PreparedPayment } from '../gatewayPay'
import { DEMO_PRICE } from '../sellers'
import { memoryStore } from './helpers'

// Everything is faked in memory: sellers, Circle's record, the clock. No file is read or written,
// so the app's .env and data folder are never touched.

const PAYER = '0xAbCdEf0000000000000000000000000000000002'
const sellers: { a: DemoSeller; b: DemoSeller } = {
  a: { name: 'Seller A', url: 'http://seller/a', address: '0x00000000000000000000000000000000000000aa' },
  b: { name: 'Seller B', url: 'http://seller/b', address: '0x00000000000000000000000000000000000000bb' },
}

type Script = 'drop-then-deliver' | 'drop-then-drop' | 'deliver'

function setup(options: { recovery: boolean; script: Script; confirmed?: boolean; count?: number; available?: bigint }) {
  const log = { prepared: 0, sends: 0, grown: 0n, confirmations: 0, counts: [] as string[][] }
  let nonceCounter = 0
  let clock = 0
  const now = () => clock

  const ports: DemoPorts = {
    holdAvailable: () => Promise.resolve(options.available ?? 1_000_000n),
    growHold: (amount) => {
      log.grown += amount
      return Promise.resolve()
    },
    prepare: (url) => {
      log.prepared++
      nonceCounter++
      const nonce = `0x${String(nonceCounter).padStart(64, '0')}`
      let sent = 0
      const payment: PreparedPayment = {
        accept: {
          scheme: 'exact',
          network: 'eip155:5042002',
          amount: '1000',
          asset: '0x3600000000000000000000000000000000000000',
          payTo: url.endsWith('/a') ? sellers.a.address : sellers.b.address,
          extra: { name: 'GatewayWalletBatched', ...(options.recovery ? { recovery: 'same-payment' } : {}) },
        },
        amount: DEMO_PRICE,
        nonce,
        payer: PAYER,
        header: { name: 'PAYMENT-SIGNATURE', value: `header-${nonce}` },
        send: () => {
          log.sends++
          sent++
          clock += 500
          const deliver = options.script === 'deliver' || (options.script === 'drop-then-deliver' && sent > 1)
          return deliver ? Promise.resolve(new Response('{"answer":"yes"}')) : Promise.reject(new Error('socket closed'))
        },
      }
      return Promise.resolve(payment)
    },
    confirmOnePayment: () => {
      log.confirmations++
      return Promise.resolve(options.confirmed ?? true)
    },
    countPayments: (_payer, _seller, nonces) => {
      log.counts.push(nonces)
      return Promise.resolve(options.count ?? 2)
    },
  }
  const receipts = memoryStore()
  const demos = createDemoService(ports, sellers, receipts, now)
  return { demos, receipts, log, tick: (ms: number) => (clock += ms) }
}

async function run(demos: ReturnType<typeof setup>['demos'], kind: 'a' | 'b' | 'compare') {
  const started = demos.start(kind)
  await demos.settled(started.id)
  const finished = demos.get(started.id)
  if (!finished) throw new Error('run should exist')
  return finished
}

describe('Seller A: the response is lost, the agent asks again', () => {
  test('fetches again with the same payment, no new signature, and shows every step', async () => {
    const { demos, receipts, log } = setup({ recovery: true, script: 'drop-then-deliver' })

    const finished = await run(demos, 'a')

    expect(finished.state).toBe('done')
    expect(finished.steps.map((s) => s.name)).toEqual([
      'hold',
      'payment',
      'waiting',
      'connection dropped',
      'fetching again',
      'delivered',
    ])
    // The agent signed once and sent that one payment twice.
    expect(log.prepared).toBe(1)
    expect(log.sends).toBe(2)
    // Seconds since the start only go up.
    const times = finished.steps.map((s) => s.atMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times.at(-1)).toBe(1000)

    const rows = receipts.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sellerName: 'Seller A',
      amount: '1000',
      timesReceived: 1,
      demo: 'a',
      outcome: ['Charged once. Delivered on the second fetch.', 'Circle record: 1 transfer for this payment.'],
    })
  })

  test('does not claim the Circle record when it cannot confirm it', async () => {
    const { demos, receipts } = setup({ recovery: true, script: 'drop-then-deliver', confirmed: false })
    await run(demos, 'a')
    expect(receipts.list()[0]?.outcome).toEqual([
      'Charged once. Delivered on the second fetch.',
      'Circle record: not confirmed yet.',
    ])
  })

  test('says nothing was delivered when the second fetch fails too', async () => {
    const { demos, receipts } = setup({ recovery: true, script: 'drop-then-drop' })
    const finished = await run(demos, 'a')
    expect(finished.steps.at(-1)?.name).toBe('fetching again')
    expect(receipts.list()[0]?.outcome?.[0]).toMatch(/^Nothing delivered/)
  })
})

describe('Seller B: the response is lost, the agent does not sign again', () => {
  test('stops after the connection drops and reads the receipt sentence', async () => {
    const { demos, receipts, log } = setup({ recovery: false, script: 'drop-then-deliver' })

    const finished = await run(demos, 'b')

    expect(finished.steps.map((s) => s.name)).toEqual(['hold', 'payment', 'waiting', 'connection dropped'])
    expect(log.prepared).toBe(1)
    expect(log.sends).toBe(1)
    expect(receipts.list()[0]).toMatchObject({
      sellerName: 'Seller B',
      timesReceived: 0,
      responseBytes: 0,
      demo: 'b',
      outcome: ['Charged once. Nothing delivered. No second charge.'],
    })
  })

  test('does not claim a charge it could not confirm', async () => {
    const { demos, receipts } = setup({ recovery: false, script: 'drop-then-deliver', confirmed: false })
    await run(demos, 'b')
    expect(receipts.list()[0]?.outcome).toEqual(['Nothing delivered. No second charge.'])
  })
})

describe('Retry as a new payment (comparison only)', () => {
  test('makes the hold 0.002 larger, signs two payments, and shows two transfers only when the record has two', async () => {
    const { demos, receipts, log } = setup({ recovery: false, script: 'drop-then-drop', count: 2 })

    const finished = await run(demos, 'compare')

    expect(COMPARISON_EXTRA_HOLD).toBe(2000n)
    expect(log.grown).toBe(2000n)
    expect(log.prepared).toBe(2)
    expect(log.sends).toBe(2)
    expect(finished.steps.map((s) => s.name)).toEqual([
      'hold',
      'payment',
      'waiting',
      'connection dropped',
      'payment',
      'waiting',
      'connection dropped',
      'waiting',
    ])

    const rows = receipts.list()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toMatchObject({ comparison: true, demo: 'compare' })
      expect(row.outcome).toEqual(['Circle record: 2 transfers. Charged twice.'])
    }
    // The count was asked for with exactly the two nonces that were signed.
    expect(log.counts[0]).toEqual(rows.map((r) => r.nonce).reverse())
  })

  test.each([0, 1, 3])('says nothing about being charged twice when the record has %i', async (count) => {
    const { demos, receipts } = setup({ recovery: false, script: 'drop-then-drop', count })
    await run(demos, 'compare')
    for (const row of receipts.list()) expect(row.outcome).toEqual([])
  })

  test('never uses the "No second charge." sentence, and leaves the Seller B row alone', async () => {
    const { demos, receipts } = setup({ recovery: false, script: 'drop-then-drop', count: 2 })
    await run(demos, 'b')
    const before = receipts.list().find((r) => r.demo === 'b')
    expect(before?.outcome?.join(' ')).toContain('No second charge.')
    const snapshot = JSON.stringify(before)

    await run(demos, 'compare')

    const after = receipts.list().find((r) => r.id === before?.id)
    expect(JSON.stringify(after)).toBe(snapshot)
    for (const row of receipts.list().filter((r) => r.comparison)) {
      expect((row.outcome ?? []).join(' ')).not.toContain('No second charge.')
    }
  })
})

describe('Running a demo', () => {
  test('needs the hold to cover the price, and signs nothing otherwise', async () => {
    const { demos, log } = setup({ recovery: true, script: 'drop-then-deliver', available: 999n })
    const finished = await run(demos, 'a')
    expect(finished.state).toBe('failed')
    expect(finished.error).toBe('The hold doesn’t cover this. Hold more first.')
    expect(log.prepared).toBe(0)
  })

  test('runs one demo at a time', async () => {
    const { demos } = setup({ recovery: true, script: 'drop-then-deliver' })
    const first = demos.start('a')
    expect(() => demos.start('b')).toThrow(DemoError)
    await demos.settled(first.id)
    expect(() => demos.start('b')).not.toThrow()
  })
})
