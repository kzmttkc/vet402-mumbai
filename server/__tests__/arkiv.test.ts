import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { custom } from 'viem'
import {
  createArkivSink,
  createArkivWire,
  createScrubber,
  createSellerCheck,
  decideDelivery,
  NOT_PAID,
  parseSellerTtl,
  RULED_AGAINST,
  UNREADABLE,
} from '../arkiv'
import type { DeliveryCheck } from '../arkiv'
import type { ArkivWire, EntityOptions, ReceiptValues, SellerRead } from '../arkiv'
import { createDemoService } from '../demo'
import type { DemoPorts } from '../demo'
import type { PreparedPayment } from '../gatewayPay'
import { createJobService } from '../jobs'
import type { JobPorts } from '../jobs'
import type { Candidate } from '../discovery'
import type { Plan } from '../planner'
import { planCheapest } from '../planner'
import { createReceiptStore } from '../receiptStore'
import type { ReceiptRow } from '../receiptStore'
import { DEMO_PRICE, SELLER_C_NAME } from '../sellers'
import { memoryStore } from './helpers'

// The Arkiv client is swapped for a fake here, so nothing reaches the network, and the only file
// work happens in a fresh temporary folder.

const KEY_A = `0x${'a'.repeat(64)}` as const
const KEY_B = `0x${'b'.repeat(64)}` as const

type Call =
  | { op: 'receipt'; values: ReceiptValues; options: EntityOptions }
  | { op: 'seller'; values: { kind: string; seller: string }; options: EntityOptions }
  | { op: 'extend'; entityKey: string; options: EntityOptions['expiration'] }

function fakeWire(overrides: Partial<ArkivWire> = {}) {
  const calls: Call[] = []
  let open = 0
  let maxOpen = 0
  let counter = 0
  const key = () => `0x${String(++counter).padStart(64, '0')}` as `0x${string}`
  const track = async <T>(work: () => T): Promise<T> => {
    open++
    maxOpen = Math.max(maxOpen, open)
    await new Promise((resolve) => setTimeout(resolve, 1))
    open--
    return work()
  }
  const wire: ArkivWire = {
    createReceipt: (values, options) =>
      track(() => {
        calls.push({ op: 'receipt', values, options })
        return { entityKey: key() }
      }),
    createSeller: (values, options) =>
      track(() => {
        calls.push({ op: 'seller', values, options })
        return { entityKey: key() }
      }),
    extendEntity: ({ entityKey, expiration }) =>
      track(() => {
        calls.push({ op: 'extend', entityKey, options: expiration })
        return { expiresAt: 1n }
      }),
    findPaymentKey: () => Promise.resolve(null),
    findSellerKey: () => Promise.resolve(null),
    readSeller: () => Promise.reject(new Error('not used')),
    ...overrides,
  }
  return { wire, calls, maxOpen: () => maxOpen }
}

const row = (over: Partial<ReceiptRow> = {}): ReceiptRow => ({
  id: 'row-1',
  at: new Date(Date.now() + 1000).toISOString(),
  amount: '1000',
  sellerName: 'Seller X',
  responseHash: 'f'.repeat(64),
  responseBytes: 42,
  timesReceived: 1,
  transferId: 'transfer-1',
  nonce: `0x${'1'.repeat(64)}`,
  status: 'received',
  batchTx: null,
  ...over,
})

function sink(wire: ArkivWire, logs: string[] = [], ttl = 604800) {
  const store = memoryStore()
  const made = createArkivSink({
    wire,
    store,
    sellerTtlSeconds: ttl,
    log: (m) => logs.push(m),
    scrub: createScrubber(['secret-access-key']),
  })
  return { ...made, inner: store }
}

const read = (over: Partial<SellerRead> = {}): SellerRead => ({
  sellerLive: false,
  paymentBlocks: [],
  verdictBlocks: [],
  currentBlock: 1000n,
  blockSeconds: 2,
  ...over,
})

describe('The delivery check, one stop condition at a time', () => {
  test('a live seller goes on with "Delivered recently."', () => {
    expect(decideDelivery(read({ sellerLive: true, paymentBlocks: [10n] }))).toEqual({
      kind: 'live',
      line: 'Delivered recently.',
    })
  })

  test('no seller entity and no payment is a first purchase, and it goes on', () => {
    expect(decideDelivery(read())).toEqual({ kind: 'first', line: 'First purchase from this seller.' })
  })

  test('payments with no live seller stop the purchase', () => {
    expect(decideDelivery(read({ paymentBlocks: [10n] }))).toEqual({
      kind: 'expired',
      line: 'No recent delivery from this seller. Not paid.',
    })
  })

  test('a payment under 60 seconds old is not counted', () => {
    // 30 blocks at 2 seconds is exactly 60 seconds, which is not older than 60.
    expect(decideDelivery(read({ paymentBlocks: [970n] })).kind).toBe('first')
    expect(decideDelivery(read({ paymentBlocks: [999n] })).kind).toBe('first')
    expect(decideDelivery(read({ paymentBlocks: [969n] })).kind).toBe('expired')
  })

  test('a failed read stops the purchase and says why, and the log carries no key', async () => {
    const logs: string[] = []
    const check = createSellerCheck(
      { readSeller: () => Promise.reject(new Error('https://rpc/secret-access-key answered 429')) },
      (m) => logs.push(m),
      createScrubber(['secret-access-key']),
    )
    expect(await check('Seller X')).toEqual({ kind: 'expired', line: UNREADABLE })
    expect(logs.join()).not.toContain('secret-access-key')
  })
})

describe('Seller A and Seller B', () => {
  test('are never checked, and the demo still pays them', async () => {
    let checks = 0
    const { wire, calls } = fakeWire({
      readSeller: () => {
        checks++
        return Promise.resolve(read({ paymentBlocks: [1n] }))
      },
    })
    const { store, idle } = sink(wire)

    const payment: PreparedPayment = {
      accept: { scheme: 'exact', network: 'eip155:5042002', amount: '1000' } as PreparedPayment['accept'],
      amount: DEMO_PRICE,
      nonce: `0x${'2'.repeat(64)}`,
      payer: '0x0000000000000000000000000000000000000002',
      header: { name: 'x', value: 'y' },
      send: () => Promise.resolve(new Response('{"ok":true}')),
    }
    const ports: DemoPorts = {
      holdAvailable: () => Promise.resolve(1_000_000n),
      growHold: () => Promise.resolve(),
      prepare: () => Promise.resolve(payment),
      confirmOnePayment: () => Promise.resolve(true),
      countPayments: () => Promise.resolve(0),
    }
    const demo = createDemoService(
      ports,
      {
        a: { name: 'Seller A', url: 'http://seller/a', address: '0x00000000000000000000000000000000000000aa' },
        b: { name: 'Seller B', url: 'http://seller/b', address: '0x00000000000000000000000000000000000000bb' },
      },
      store,
    )
    for (const kind of ['a', 'b'] as const) {
      const run = demo.start(kind)
      await demo.settled(run.id)
      expect(demo.get(run.id)?.state).toBe('done')
    }
    await idle()

    expect(checks).toBe(0)
    expect(store.list()).toHaveLength(2)
    // No transfer id yet, so nothing has been written. The rows are on screen regardless.
    expect(calls).toHaveLength(0)
  })
})

describe('Writing behind the local store', () => {
  test('a payment entity on "received", a settlement holding its key on "completed"', async () => {
    const { wire, calls } = fakeWire()
    const { store, idle, inner } = sink(wire)

    store.add(row())
    await idle()
    store.update('row-1', { status: 'completed', batchTx: `0x${'c'.repeat(64)}` })
    await idle()

    const receipts = calls.filter((c) => c.op === 'receipt')
    expect(receipts).toHaveLength(2)
    const [payment, settlement] = receipts
    expect(payment?.values).toEqual({
      kind: 'payment',
      job_id: 'row-1',
      seller: 'Seller X',
      amount_micro: 1000n,
      gateway_transfer_id: 'transfer-1',
      response_hash: 'f'.repeat(64),
      response_bytes: 42n,
      times_received: 1n,
      status: 'accepted',
    })
    expect(settlement?.values.kind).toBe('settlement')
    expect(settlement?.values.status).toBe('settled')
    expect(settlement?.values.batch_tx).toBe(`0x${'c'.repeat(64)}`)
    expect(settlement?.values.payment_key).toBe(inner.list()[0]?.arkivPaymentKey as string)
    for (const c of receipts) {
      expect(c.options.flags).toEqual({ readonly: true, permissionlessExtension: true })
      // 30 days at 2 seconds a block.
      expect(c.options.expiration.minLifetime).toBe(1_296_000n)
    }
  })

  test('nothing is written before Gateway gives a transfer id', async () => {
    const { wire, calls } = fakeWire()
    const { store, idle } = sink(wire)
    store.add(row({ transferId: null }))
    await idle()
    expect(calls).toHaveLength(0)
    store.update('row-1', { transferId: 'transfer-1' })
    await idle()
    expect(calls.map((c) => c.op)).toEqual(['receipt', 'seller'])
  })

  test('no response: the no-response hash, and no seller entity or extension', async () => {
    const { wire, calls } = fakeWire()
    const { store, idle } = sink(wire)
    store.add(row({ timesReceived: 0, responseBytes: 0 }))
    await idle()
    store.update('row-1', { status: 'completed' })
    await idle()

    expect(calls.map((c) => c.op)).toEqual(['receipt', 'receipt'])
    const expected = createHash('sha256').update('no-response:transfer-1').digest('hex')
    for (const c of calls) if (c.op === 'receipt') expect(c.values.response_hash).toBe(expected)
  })

  test('the seller entity is created once, then extended and never given permissionless extension', async () => {
    const { wire, calls } = fakeWire()
    const { store, idle } = sink(wire)
    store.add(row({ id: 'one', transferId: 't1' }))
    await idle()
    store.add(row({ id: 'two', transferId: 't2' }))
    await idle()

    const sellerCalls = calls.filter((c) => c.op !== 'receipt')
    expect(sellerCalls.map((c) => c.op)).toEqual(['seller', 'extend'])
    const created = sellerCalls[0]
    if (created?.op !== 'seller') throw new Error('expected a seller entity')
    expect(created.options.flags).toEqual({ readonly: true })
    expect(created.options.expiration.minLifetime).toBe(302_400n)
    const extended = sellerCalls[1]
    if (extended?.op !== 'extend') throw new Error('expected an extension')
    expect(extended.options.minLifetime).toBe(302_400n)
  })

  test('only Seller C uses the short lifetime', async () => {
    const { wire, calls } = fakeWire()
    const { store, idle } = sink(wire, [], 60)
    store.add(row({ id: 'c', transferId: 'tc', sellerName: SELLER_C_NAME }))
    store.add(row({ id: 'x', transferId: 'tx', sellerName: 'Seller X' }))
    await idle()
    const lifetimes = Object.fromEntries(
      calls.flatMap((c) => (c.op === 'seller' ? [[c.values.seller, c.options.expiration.minLifetime]] : [])),
    )
    expect(lifetimes).toEqual({ [SELLER_C_NAME]: 30n, 'Seller X': 302_400n })
  })

  test('an expired seller entity starts over instead of failing', async () => {
    const { wire, calls } = fakeWire({
      extendEntity: () => Promise.reject(new Error('entity not found')),
    })
    const { store, idle, inner } = sink(wire)
    store.add(row({ id: 'one', transferId: 't1' }))
    await idle()
    store.add(row({ id: 'two', transferId: 't2' }))
    await idle()
    expect(calls.filter((c) => c.op === 'seller')).toHaveLength(2)
    expect(inner.list().every((r) => r.arkivSellerDone)).toBe(true)
  })

  test('writes go one at a time, from one queue', async () => {
    const { wire, maxOpen, calls } = fakeWire()
    const { store, idle } = sink(wire)
    for (let i = 0; i < 5; i++) store.add(row({ id: `r${i}`, transferId: `t${i}` }))
    await idle()
    expect(calls.length).toBeGreaterThan(5)
    expect(maxOpen()).toBe(1)
  })

  test('a failed write does not stop anything, keeps the row, and logs no key', async () => {
    const logs: string[] = []
    const { wire } = fakeWire({
      createReceipt: () => Promise.reject(new Error('POST https://rpc/secret-access-key failed')),
    })
    const { store, idle, inner } = sink(wire, logs)
    expect(() => store.add(row({ outcome: ['Charged once. Delivered.'] }))).not.toThrow()
    await idle()
    expect(inner.list()[0]?.outcome).toEqual(['Charged once. Delivered.'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('secret-access-key')
  })

  test('a retry looks first, so a write that landed is not written twice', async () => {
    let fail = true
    let lookups = 0
    const base = fakeWire()
    const wire: ArkivWire = {
      ...base.wire,
      createReceipt: (values, options) => {
        if (fail) return Promise.reject(new Error('timed out'))
        return base.wire.createReceipt(values, options)
      },
      findPaymentKey: () => {
        lookups++
        return Promise.resolve(`0x${'9'.repeat(64)}`)
      },
    }
    const { store, idle, sweep, inner } = sink(wire)
    store.add(row())
    await idle()
    fail = false
    sweep()
    await idle()
    expect(lookups).toBe(1)
    expect(base.calls.filter((c) => c.op === 'receipt')).toHaveLength(0)
    expect(inner.list()[0]?.arkivPaymentKey).toBe(`0x${'9'.repeat(64)}`)
  })

  test('the sweep leaves rows from before this run alone', async () => {
    const { wire, calls } = fakeWire()
    const { sweep, idle, inner } = sink(wire)
    inner.add(row({ at: '2026-01-01T00:00:00.000Z' }))
    sweep()
    await idle()
    expect(calls).toHaveLength(0)
  })

  test('the written values carry no body, job text, or address of the user', async () => {
    const { wire, calls } = fakeWire()
    const { store, idle } = sink(wire)
    store.add(row({ status: 'completed' }))
    await idle()
    const keys = new Set(calls.flatMap((c) => (c.op === 'extend' ? [] : Object.keys(c.values))))
    expect([...keys].sort()).toEqual(
      [
        'amount_micro',
        'gateway_transfer_id',
        'job_id',
        'kind',
        'payment_key',
        'response_bytes',
        'response_hash',
        'seller',
        'status',
        'times_received',
      ].sort(),
    )
    expect(JSON.stringify(calls, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(
      row().nonce as string,
    )
  })

  test('the file store survives it, in a temporary folder only', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'arkiv-test-'))
    try {
      const { wire } = fakeWire()
      const local = createReceiptStore(dir)
      const made = createArkivSink({
        wire,
        store: local,
        sellerTtlSeconds: 60,
        log: () => undefined,
        scrub: createScrubber([]),
      })
      made.store.add(row())
      await made.idle()
      expect(local.list()[0]?.arkivPaymentKey).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('The real client over a fake transport', () => {
  function capture() {
    const queries: string[] = []
    const transport = custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'arkiv_query') {
          queries.push((params as string[])[0] ?? '')
          return Promise.resolve({ data: [], blockNumber: '0x64' })
        }
        if (method === 'arkiv_getBlockTiming') {
          return Promise.resolve({ current_block: 100, current_block_time: 1000, duration: 2 })
        }
        return Promise.reject(new Error(`unexpected ${method}`))
      },
    })
    return { transport, queries }
  }

  test('derives the address, and every query filters on the writer', async () => {
    const { transport, queries } = capture()
    const { wire, writer } = createArkivWire({ writerKey: KEY_A, accessKey: '', transport })
    expect(writer).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(JSON.stringify(writer)).not.toContain(KEY_A.slice(2))

    await wire.readSeller({ name: 'Seller X', payTo: null })
    await wire.findSellerKey({ name: 'Seller X', payTo: null })
    await wire.findPaymentKey('transfer-1')

    expect(queries).toHaveLength(4)
    for (const query of queries) expect(query.toLowerCase()).toContain(`$owner = addr(${writer.toLowerCase()})`)
  })

  test('different keys give different writers', () => {
    const { transport } = capture()
    const a = createArkivWire({ writerKey: KEY_A, accessKey: '', transport })
    const b = createArkivWire({ writerKey: KEY_B, accessKey: '', transport })
    expect(a.writer).not.toBe(b.writer)
  })
})

describe('SELLER_TTL_SECONDS', () => {
  test('rounds up to whole blocks, and falls back to seven days', () => {
    expect(parseSellerTtl('60')).toBe(60)
    expect(parseSellerTtl('61')).toBe(62)
    expect(parseSellerTtl(undefined)).toBe(604800)
    expect(parseSellerTtl('nonsense')).toBe(604800)
    expect(parseSellerTtl('-5')).toBe(604800)
  })
})

describe('The approval card with the delivery check', () => {
  const candidate = (sellerName: string, amount: bigint, matchText = 'prices'): Candidate => ({
    resource: `https://${sellerName.toLowerCase().replace(/\s/g, '')}.example.com/data`,
    method: 'GET',
    sellerName,
    category: 'FINANCIAL_ANALYSIS',
    amount,
    path: '/data',
    payTo: null,
    sealedBy: null,
    bodySchema: null,
    matchText,
  })

  const ports = (candidates: Candidate[]): JobPorts => ({
    candidates: () => Promise.resolve(candidates),
    latestReceipt: () => Promise.resolve(null),
    holdAvailable: () => Promise.resolve(1_000_000n),
    pay: () => Promise.reject(new Error('not used')),
    findTransfer: () => Promise.resolve(null),
    fetchTransfer: () => Promise.reject(new Error('not used')),
  })

  const sellerCPlan: Plan = {
    kind: 'lookup',
    sellerName: SELLER_C_NAME,
    summary: 'Takes care of this job for you.',
    amount: DEMO_PRICE,
    request: { url: 'http://127.0.0.1:3001/sellers/c', method: 'GET' },
  }

  const verdict = (map: Record<string, 'live' | 'first' | 'expired'>) => (seller: string) =>
    Promise.resolve(
      {
        live: { kind: 'live', line: 'Delivered recently.' } as const,
        first: { kind: 'first', line: 'First purchase from this seller.' } as const,
        expired: { kind: 'expired', line: NOT_PAID } as const,
      }[map[seller] ?? 'first'],
    )

  test('a seller with no recent delivery is passed over, with the sentence above the card', async () => {
    const service = createJobService(
      ports([candidate('Cheap', 1000n), candidate('Dear', 2000n)]),
      memoryStore(),
      undefined,
      { sellerCheck: verdict({ Cheap: 'expired', Dear: 'live' }) },
    )
    const view = await service.plan('find prices')
    expect(view.sellerName).toBe('Dear')
    expect(view.notices).toEqual(['Cheap: No recent delivery from this seller. Not paid.'])
    expect(view.delivery).toBe('Delivered recently.')
  })

  test('a read failure pays nobody: the seller is passed over and no card is shown for it', async () => {
    const failing = createSellerCheck(
      { readSeller: () => Promise.reject(new Error('429')) },
      () => undefined,
      createScrubber([]),
    )
    const service = createJobService(ports([candidate('Cheap', 1000n)]), memoryStore(), undefined, {
      sellerCheck: failing,
    })
    await expect(service.plan('find prices')).rejects.toThrow('I couldn’t find anyone who can do this job.')
  })

  test('with Arkiv off, the card is what it always was', async () => {
    const service = createJobService(ports([candidate('Cheap', 1000n)]), memoryStore())
    const view = await service.plan('find prices')
    expect(view.notices).toBeUndefined()
    expect(view.delivery).toBeUndefined()
  })

  test('when every seller is passed over, nobody is paid', async () => {
    const service = createJobService(ports([candidate('Cheap', 1000n)]), memoryStore(), undefined, {
      sellerCheck: verdict({ Cheap: 'expired' }),
    })
    await expect(service.plan('find prices')).rejects.toThrow('I couldn’t find anyone who can do this job.')
  })

  test('the Seller C scene offers Seller C first', async () => {
    const service = createJobService(ports([candidate('Cheap', 1000n)]), memoryStore(), undefined, {
      sellerCheck: verdict({ [SELLER_C_NAME]: 'first' }),
      sellerCPlan,
    })
    const view = await service.planSellerScene()
    expect(view.sellerName).toBe(SELLER_C_NAME)
    expect(view.amount).toBe('0.001')
    expect(view.delivery).toBe('First purchase from this seller.')
  })

  test('once Seller C has expired, the cheapest listing is next and Seller C is not paid', async () => {
    const service = createJobService(
      ports([candidate('Dear', 5000n), candidate('Cheap', 1000n, 'unrelated words')]),
      memoryStore(),
      undefined,
      { sellerCheck: verdict({ [SELLER_C_NAME]: 'expired' }), sellerCPlan },
    )
    const view = await service.planSellerScene()
    expect(view.sellerName).toBe('Cheap')
    expect(view.notices).toEqual(['Seller C: No recent delivery from this seller. Not paid.'])
  })

  // A ruling and an unreadable record stop a purchase as surely as no delivery. The line above the card says which.
  const because = (map: Record<string, DeliveryCheck>) => (seller: string) =>
    Promise.resolve(map[seller] ?? ({ kind: 'first', line: 'First purchase from this seller.' } as const))

  test('the line above the card says why each seller was passed over: ruled against, or unreadable', async () => {
    const service = createJobService(
      ports([candidate('Ruled', 1000n), candidate('Dark', 2000n), candidate('Fine', 3000n)]),
      memoryStore(),
      undefined,
      {
        sellerCheck: because({
          Ruled: { kind: 'expired', line: RULED_AGAINST },
          Dark: { kind: 'expired', line: UNREADABLE },
          Fine: { kind: 'live', line: 'Delivered recently.' },
        }),
      },
    )
    const view = await service.plan('find prices')
    expect(view.sellerName).toBe('Fine')
    expect(view.notices).toEqual([`Ruled: ${RULED_AGAINST}`, `Dark: ${UNREADABLE}`])
    expect(view.delivery).toBe('Delivered recently.')
  })

  test('in the Seller C scene too, each passed-over seller carries its own reason', async () => {
    const service = createJobService(
      ports([candidate('Dark', 1000n, 'unrelated words'), candidate('Fine', 5000n)]),
      memoryStore(),
      undefined,
      {
        sellerCheck: because({
          [SELLER_C_NAME]: { kind: 'expired', line: RULED_AGAINST },
          Dark: { kind: 'expired', line: UNREADABLE },
        }),
        sellerCPlan,
      },
    )
    const view = await service.planSellerScene()
    expect(view.sellerName).toBe('Fine')
    expect(view.notices).toEqual([`${SELLER_C_NAME}: ${RULED_AGAINST}`, `Dark: ${UNREADABLE}`])
  })

  test('a catalog listing cannot pass as Seller C', async () => {
    const service = createJobService(ports([candidate(SELLER_C_NAME, 1n)]), memoryStore(), undefined, {
      sellerCheck: verdict({}),
    })
    await expect(service.plan('find prices')).rejects.toThrow('I couldn’t find anyone who can do this job.')
  })

  test('the cheapest plan skips the relay and anything unsafe', () => {
    // A JSON-RPC node is known by the request it asks for, not by its path.
    const relay: Candidate = {
      ...candidate('Relay', 1n),
      method: 'POST',
      path: '/arc-testnet',
      bodySchema: { required: ['jsonrpc', 'method'], properties: ['jsonrpc', 'method', 'params', 'id'] },
    }
    const unsafe = { ...candidate('Local', 2n), resource: 'http://127.0.0.1/data' }
    const outcome = planCheapest('job', [relay, unsafe, candidate('Fine', 3n)])
    expect(outcome.ok && outcome.plan.sellerName).toBe('Fine')
  })
})
