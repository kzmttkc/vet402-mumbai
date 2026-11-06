import { describe, expect, test } from 'bun:test'
import { custom, keccak256, toBytes } from 'viem'
import type { Hex } from 'viem'
import {
  createArkivSink,
  createArkivWire,
  createScrubber,
  createSellerCheck,
  decideDelivery,
  keptPromise,
  payToByName,
  RULED_AGAINST,
  UNREADABLE,
  verdictToArkiv,
} from '../arkiv'
import type { ArkivWire, EntityOptions, ReceiptValues, SellerId, SellerRead, SellerValues, VerdictValues } from '../arkiv'
import { createDemoService, KEY_FROM_CHAIN } from '../demo'
import type { DemoPorts, DemoRunView } from '../demo'
import type { ReceiptRow } from '../receiptStore'
import type { SealedBox, SealedPorts } from '../sealedDelivery'
import { DEMO_PRICE } from '../sellers'
import { createArkivReader } from '../../src/arkiv/readArkiv'
import { MAX_PAGES, PAGE_SIZE, readAllPages } from '../../src/arkiv/pages'
import { buildRows } from '../../src/arkiv/receiptsFeed'
import { sealResponse } from '../../src/lib/sealed'
import { memoryStore } from './helpers'

// Arkiv and Arc are fakes here. Nothing leaves this machine.

const WRITER = '0x00000000000000000000000000000000000000aa'
const KEY = `0x${'a'.repeat(64)}` as const
const PAY_TO = '0xAbCdEf00000000000000000000000000000000C1'
const PAY_TO_LOWER = PAY_TO.toLowerCase()
const CLAIM_ID: Hex = `0x${'c2'.repeat(32)}`
const CLAIM_TX: Hex = `0x${'c3'.repeat(32)}`
const CONTRACT = '0xA1EFF55DA9F1CEE94D608E2570BDA89F8F2CE5B5'
const attr = (name: string, type: string, value: unknown) => ({ name, type, value })
const hex = (n: number) => `0x${n.toString(16)}`
const keyOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

/** A node that holds `rows` and answers each query by its filters, one page at a time, as the real node does. */
function fakeNode(rows: { key: string; createdAt?: number; attributes: ReturnType<typeof attr>[] }[]) {
  const queries: { query: string; limit: number; offset: number }[] = []
  const matches = (query: string, row: (typeof rows)[number]) =>
    [...query.matchAll(/(\w[\w.]*) = str\('([^']*)'\)/g)].every(([, name, value]) =>
      row.attributes.some((a) => a.name === name && a.value === value),
    )
  const transport = custom({
    request: ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'arkiv_getBlockTiming') {
        return Promise.resolve({ current_block: 1_000_000, current_block_time: 1_793_000_000, duration: 2 })
      }
      if (method !== 'arkiv_query') return Promise.reject(new Error(`unexpected ${method}`))
      const [query, options] = params as [string, { limit?: string; offset?: string }]
      const limit = Number(options.limit ?? '0x64')
      const offset = Number(options.offset ?? '0x0')
      queries.push({ query, limit, offset })
      const all = rows.filter((row) => matches(query, row)).sort((a, b) => (a.key < b.key ? -1 : 1))
      return Promise.resolve({
        blockNumber: '0xf4240',
        data: all.slice(offset, offset + limit).map((row) => ({
          key: row.key,
          expiresAt: '0x13d620',
          ...(row.createdAt === undefined ? {} : { createdAt: hex(row.createdAt) }),
          attributes: row.attributes,
        })),
      })
    },
  })
  return { transport, queries }
}

const receiptRow = (n: number, kind: 'payment' | 'settlement', extra: ReturnType<typeof attr>[] = []) => ({
  key: keyOf(n),
  createdAt: 10,
  attributes: [
    attr('arkiv.schema', 'str', 'vet402_receipt'),
    attr('kind', 'str', kind),
    attr('seller', 'str', 'Seller A'),
    attr('amount_micro', 'u64', '0x3e8'),
    attr('gateway_transfer_id', 'str', `transfer-${n}`),
    attr('response_hash', 'str', 'abc'),
    attr('response_bytes', 'u64', '0x2a'),
    attr('times_received', 'u64', '0x1'),
    ...extra,
  ],
})

describe('The receipts page reads every receipt, by kind, page by page', () => {
  test('105 payments and 51 settlements all arrive, with nothing dropped at 100', async () => {
    const rows = [
      ...Array.from({ length: 105 }, (_, i) => receiptRow(i + 1, 'payment')),
      ...Array.from({ length: 51 }, (_, i) =>
        receiptRow(1000 + i, 'settlement', [attr('payment_key', 'str', keyOf(i + 1)), attr('batch_tx', 'str', '0xbatch')]),
      ),
    ]
    const { transport, queries } = fakeNode(rows)
    const read = await createArkivReader(WRITER, transport)()

    expect(read.receipts.filter((r) => r.kind === 'payment')).toHaveLength(105)
    expect(read.receipts.filter((r) => r.kind === 'settlement')).toHaveLength(51)
    const screen = buildRows(read)
    expect(screen).toHaveLength(105)
    expect(screen.filter((row) => row.settled)).toHaveLength(51)

    const paymentPages = queries.filter((q) => q.query.includes("kind = str('payment')"))
    expect(paymentPages.map((q) => q.offset)).toEqual([0, 100])
    expect(queries.filter((q) => q.query.includes("kind = str('settlement')"))).toHaveLength(1)
    for (const q of queries) {
      expect(q.limit).toBe(PAGE_SIZE)
      expect(q.query.toLowerCase()).toContain(`$owner = addr(${WRITER})`)
      expect(q.query).toMatch(/kind = str\('/)
    }
  })

  test('a query past the page cap stops loudly instead of returning part of the rows', async () => {
    const full = { entities: Array.from({ length: PAGE_SIZE }, (_, i) => ({ $key: `k${i}` })), skipped: 0 }
    let pages = 0
    const endless = (offset: number) => {
      pages++
      return Promise.resolve({ ...full, entities: full.entities.map((e) => ({ $key: `${offset}-${e.$key}` })) })
    }
    await expect(readAllPages(endless)).rejects.toThrow('Not all were read')
    expect(pages).toBe(MAX_PAGES)
  })

  test('rows the schema skips still move the offset on', async () => {
    const offsets: number[] = []
    const rows = await readAllPages((offset) => {
      offsets.push(offset)
      return Promise.resolve(
        offset === 0 ? { entities: [{ $key: 'a' }], skipped: 99 } : { entities: [{ $key: 'b' }], skipped: 0 },
      )
    })
    expect(offsets).toEqual([0, 100])
    expect(rows.map((r) => r.$key)).toEqual(['a', 'b'])
  })

  test('a ruling shows on that seller’s rows, matched by payTo and not by name', async () => {
    const { transport } = fakeNode([
      receiptRow(1, 'payment', [attr('pay_to', 'str', PAY_TO_LOWER)]),
      { ...receiptRow(2, 'payment'), attributes: receiptRow(2, 'payment').attributes.map((a) => (a.name === 'seller' ? attr('seller', 'str', 'Seller B') : a)) },
      {
        key: keyOf(3000),
        createdAt: 999_000,
        attributes: [
          attr('arkiv.schema', 'str', 'vet402_verdict'),
          attr('kind', 'str', 'verdict'),
          attr('claim_id', 'str', CLAIM_ID),
          attr('seller', 'str', PAY_TO_LOWER),
          attr('verdict', 'str', 'fraud'),
          attr('contract', 'str', CONTRACT.toLowerCase()),
          attr('chain_id', 'u64', '0x4cef52'),
        ],
      },
    ])
    const screen = buildRows(await createArkivReader(WRITER, transport)())
    const ruled = screen.find((row) => row.seller === 'Seller A')
    expect(ruled?.ruledAgainst).toBe('2026-10-26')
    expect(screen.find((row) => row.seller === 'Seller B')?.ruledAgainst).toBeNull()
  })
})

const read = (over: Partial<SellerRead> = {}): SellerRead => ({
  sellerLive: false,
  paymentBlocks: [],
  verdictBlocks: [],
  currentBlock: 1_000_000n,
  blockSeconds: 2,
  ...over,
})

describe('Arc’s ruling decides before anything else', () => {
  test('a ruling in the last 7 days refuses the seller, even one that delivered recently', () => {
    expect(decideDelivery(read({ sellerLive: true, verdictBlocks: [999_000n] }))).toEqual({
      kind: 'expired',
      line: RULED_AGAINST,
    })
  })

  test('a ruling older than 7 days no longer refuses on its own', () => {
    // 302,400 blocks at 2 seconds is exactly 7 days.
    expect(decideDelivery(read({ sellerLive: true, verdictBlocks: [1_000_000n - 302_400n] })).kind).toBe('live')
    expect(decideDelivery(read({ sellerLive: true, verdictBlocks: [1_000_000n - 302_399n] })).kind).toBe('expired')
  })

  test('the check asks Arkiv by payTo when vet402 knows the address', async () => {
    const asked: SellerId[] = []
    const check = createSellerCheck(
      {
        readSeller: (seller) => {
          asked.push(seller)
          return Promise.resolve(read({ verdictBlocks: [999_999n] }))
        },
      },
      () => undefined,
      createScrubber([]),
      (name) => (name === 'Seller D' ? PAY_TO : null),
    )
    expect(await check('Seller D')).toEqual({ kind: 'expired', line: RULED_AGAINST })
    expect(await check('Catalog seller')).toEqual({ kind: 'expired', line: RULED_AGAINST })
    expect(asked).toEqual([
      { name: 'Seller D', payTo: PAY_TO },
      { name: 'Catalog seller', payTo: null },
    ])
  })

  test('a read that fails pays nobody', async () => {
    const check = createSellerCheck({ readSeller: () => Promise.reject(new Error('429')) }, () => undefined, createScrubber([]))
    expect(await check('Seller D')).toEqual({ kind: 'expired', line: UNREADABLE })
  })
})

describe('The real client finds a seller by payTo', () => {
  test('the seller entity, its payments and its rulings are all filtered on the address', async () => {
    const payments = Array.from({ length: 150 }, (_, i) => ({
      ...receiptRow(i + 1, 'payment', [attr('pay_to', 'str', PAY_TO_LOWER)]),
      createdAt: 5,
    }))
    // Same name, another address: it must not count.
    const impostor = { ...receiptRow(9999, 'payment', [attr('pay_to', 'str', '0x' + '9'.repeat(40))]), createdAt: 5 }
    const verdict = {
      key: keyOf(5000),
      createdAt: 999_990,
      attributes: [
        attr('arkiv.schema', 'str', 'vet402_verdict'),
        attr('kind', 'str', 'verdict'),
        attr('claim_id', 'str', CLAIM_ID),
        attr('seller', 'str', PAY_TO_LOWER),
        attr('verdict', 'str', 'silent'),
        attr('contract', 'str', CONTRACT.toLowerCase()),
        attr('chain_id', 'u64', '0x4cef52'),
      ],
    }
    const { transport, queries } = fakeNode([...payments, impostor, verdict])
    const { wire } = createArkivWire({ writerKey: KEY, accessKey: '', transport })

    const got = await wire.readSeller({ name: 'Seller A', payTo: PAY_TO })
    expect(got.paymentBlocks).toHaveLength(150)
    expect(got.verdictBlocks).toEqual([999_990n])
    expect(decideDelivery(got)).toEqual({ kind: 'expired', line: RULED_AGAINST })

    for (const q of queries) {
      expect(q.query).toContain(`str('${PAY_TO_LOWER}')`)
      expect(q.query).not.toContain("seller = str('Seller A')")
    }
    expect(queries.some((q) => q.query.includes("arkiv.schema = str('vet402_seller')") && q.query.includes('pay_to ='))).toBe(true)
    expect(queries.some((q) => q.query.includes("arkiv.schema = str('vet402_verdict')"))).toBe(true)

    await wire.findSellerKey({ name: 'Seller A', payTo: PAY_TO })
    expect(queries.at(-1)?.query).toContain(`pay_to = str('${PAY_TO_LOWER}')`)
  })
})

type Call =
  | { op: 'receipt'; values: ReceiptValues; options: EntityOptions }
  | { op: 'seller'; values: SellerValues; options: EntityOptions }
  | { op: 'verdict'; values: VerdictValues; options: EntityOptions }
  | { op: 'extend'; entityKey: string }
  | { op: 'findSeller'; seller: SellerId }
  | { op: 'findVerdict'; claimId: string }

function fakeWire(overrides: Partial<ArkivWire> = {}) {
  const calls: Call[] = []
  let n = 0
  const key = () => keyOf(++n) as Hex
  const wire: ArkivWire = {
    createReceipt: (values, options) => (calls.push({ op: 'receipt', values, options }), Promise.resolve({ entityKey: key() })),
    createSeller: (values, options) => (calls.push({ op: 'seller', values, options }), Promise.resolve({ entityKey: key() })),
    createEvidence: () => Promise.resolve({ entityKey: key() }),
    createVerdict: (values, options) => (calls.push({ op: 'verdict', values, options }), Promise.resolve({ entityKey: key() })),
    extendEntity: ({ entityKey }) => (calls.push({ op: 'extend', entityKey }), Promise.resolve({ expiresAt: 1n })),
    findPaymentKey: () => Promise.resolve(null),
    findSellerKey: (seller) => (calls.push({ op: 'findSeller', seller }), Promise.resolve(null)),
    findEvidenceKey: () => Promise.resolve(null),
    findVerdictKey: (claimId) => (calls.push({ op: 'findVerdict', claimId }), Promise.resolve(null)),
    readSeller: () => Promise.reject(new Error('not used')),
    ...overrides,
  }
  return { wire, calls }
}

const row = (over: Partial<ReceiptRow> = {}): ReceiptRow => ({
  id: 'row-1',
  at: new Date(Date.now() + 1000).toISOString(),
  amount: '1000',
  sellerName: 'Seller D',
  responseHash: 'f'.repeat(64),
  responseBytes: 42,
  timesReceived: 1,
  transferId: 'transfer-1',
  nonce: `0x${'1'.repeat(64)}`,
  status: 'received',
  batchTx: null,
  ...over,
})

const sinkWith = (wire: ArkivWire, logs: string[] = [], payToOf = (name: string) => (name === 'Seller D' ? PAY_TO : null)) =>
  createArkivSink({ wire, store: memoryStore(), sellerTtlSeconds: 604800, log: (m) => logs.push(m), scrub: createScrubber([]), payToOf })

const ruling = { claimId: CLAIM_ID, payTo: PAY_TO, verdict: 'fraud' as const, claimTx: CLAIM_TX, contract: CONTRACT, chainId: 5042002 }

describe('The verdict entity', () => {
  test('is a new readonly entity with the claim, the payTo, the ruling, the claim transaction, the contract and the chain', async () => {
    const { wire, calls } = fakeWire()
    const sink = sinkWith(wire)
    sink.recordVerdict(ruling)
    await sink.idle()

    const written = calls.filter((c) => c.op === 'verdict')
    expect(written).toHaveLength(1)
    const [entity] = written
    if (entity?.op !== 'verdict') throw new Error('expected a verdict')
    expect(entity.values).toEqual({
      kind: 'verdict',
      claim_id: CLAIM_ID,
      seller: PAY_TO_LOWER,
      verdict: 'fraud',
      claim_tx: CLAIM_TX,
      contract: CONTRACT.toLowerCase(),
      chain_id: 5042002n,
    })
    expect(entity.options.flags).toEqual({ readonly: true, permissionlessExtension: true })
    expect(entity.options.expiration.minLifetime).toBe(1_296_000n)
  })

  test('a failed write is tried again by the sweep, which looks first so the ruling is never written twice', async () => {
    let fail = true
    const logs: string[] = []
    const { wire, calls } = fakeWire({
      createVerdict: (values, options) => {
        calls.push({ op: 'verdict', values, options })
        if (fail) return Promise.reject(new Error('nonce too low'))
        return Promise.resolve({ entityKey: keyOf(1) as Hex })
      },
      findVerdictKey: (claimId) => {
        calls.push({ op: 'findVerdict', claimId })
        // The first attempt landed after all.
        return Promise.resolve(keyOf(77) as Hex)
      },
    })
    const sink = sinkWith(wire, logs)
    sink.recordVerdict(ruling)
    await sink.idle()
    expect(logs.join()).toContain('Arkiv verdict write failed')
    fail = false
    sink.sweep()
    await sink.idle()
    expect(calls.filter((c) => c.op === 'verdict')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'findVerdict')).toEqual([{ op: 'findVerdict', claimId: CLAIM_ID }])
    sink.sweep()
    await sink.idle()
    expect(calls.filter((c) => c.op === 'findVerdict')).toHaveLength(1)
  })
})

describe('Payment and seller entities carry the payTo address', () => {
  test('payment, settlement and seller entities hold pay_to, and the seller is looked up by it', async () => {
    const { wire, calls } = fakeWire()
    const sink = sinkWith(wire)
    sink.store.add(row({ status: 'completed' }))
    await sink.idle()

    const receipts = calls.flatMap((c) => (c.op === 'receipt' ? [c.values] : []))
    expect(receipts.map((r) => [r.kind, r.pay_to])).toEqual([
      ['payment', PAY_TO_LOWER],
      ['settlement', PAY_TO_LOWER],
    ])
    expect(calls.find((c) => c.op === 'seller')).toMatchObject({ values: { kind: 'seller', seller: 'Seller D', pay_to: PAY_TO_LOWER } })
    expect(calls.find((c) => c.op === 'findSeller')).toEqual({ op: 'findSeller', seller: { name: 'Seller D', payTo: PAY_TO } })
  })

  test('without a known address the entities hold the name alone, as before', async () => {
    const { wire, calls } = fakeWire()
    const sink = sinkWith(wire, [], () => null)
    sink.store.add(row({ sellerName: 'Catalog seller' }))
    await sink.idle()
    const payment = calls.find((c) => c.op === 'receipt')
    expect(payment?.op === 'receipt' && 'pay_to' in payment.values).toBe(false)
  })
})

describe('The payTo of our own sellers, as server/index.ts builds it', () => {
  const payToOf = payToByName({ 'Seller A': '0xA', 'Seller C': '0xC', 'Seller D': PAY_TO })

  test('our sellers map to their address, and a catalog seller to null', () => {
    expect(payToOf('Seller A')).toBe('0xA')
    expect(payToOf('Seller C')).toBe('0xC')
    expect(payToOf('Seller D')).toBe(PAY_TO)
    expect(payToOf('Catalog seller')).toBeNull()
    expect(payToOf('seller d')).toBeNull()
  })

  test('the check reads by that payTo, and the payment entity carries it', async () => {
    const asked: SellerId[] = []
    const check = createSellerCheck(
      { readSeller: (seller) => (asked.push(seller), Promise.resolve(read({}))) },
      () => undefined,
      createScrubber([]),
      payToOf,
    )
    await check('Seller D')
    await check('Catalog seller')
    expect(asked).toEqual([
      { name: 'Seller D', payTo: PAY_TO },
      { name: 'Catalog seller', payTo: null },
    ])

    const { wire, calls } = fakeWire()
    const sink = sinkWith(wire, [], payToOf)
    sink.store.add(row())
    await sink.idle()
    const payment = calls.find((c) => c.op === 'receipt')
    expect(payment?.op === 'receipt' && payment.values.pay_to).toBe(PAY_TO_LOWER)
  })
})

describe('Only a delivery that kept its promise extends the seller', () => {
  const sealedRecord = { ciphertext: '0x00' as Hex, claimId: CLAIM_ID, plaintextHash: '0x11' as Hex, keyBlock: '7' }

  test('a sealed answer that did not match is not a delivery, one that matched is', async () => {
    expect(keptPromise(row({ sealed: sealedRecord, outcome: [] }))).toBe(false)
    expect(keptPromise(row({ sealed: sealedRecord, outcome: ['Wrong key rejected by the contract.'] }))).toBe(false)
    expect(keptPromise(row({ sealed: sealedRecord, outcome: [KEY_FROM_CHAIN] }))).toBe(true)
    expect(keptPromise(row({ outcome: ['Charged once. Delivered.'] }))).toBe(true)
    expect(keptPromise(row({ timesReceived: 0 }))).toBe(false)

    const { wire, calls } = fakeWire()
    const sink = sinkWith(wire)
    sink.store.add(row({ id: 'swapped', sealed: sealedRecord, outcome: [] }))
    await sink.idle()
    expect(calls.some((c) => c.op === 'seller' || c.op === 'extend')).toBe(false)
    sink.sweep()
    await sink.idle()
    expect(calls.filter((c) => c.op === 'receipt')).toHaveLength(1)
  })
})

describe('The demo writes Arc’s ruling after finalize and prove', () => {
  const PAYER = '0xAbCdEf0000000000000000000000000000000002'

  function setup(
    path: 'silent' | 'fraud',
    verdict: DemoPorts['verdict'],
    finalize: () => Promise<bigint> = () => Promise.resolve(1000n),
    receipts = memoryStore(),
  ) {
    const promised = sealResponse('{"answer":"the promised one"}')
    // Fraud: the key opens the box, but the bytes inside are not the ones the seller promised.
    const delivered = sealResponse('{"answer":"a swapped one"}', promised.key)
    const box: SealedBox = {
      ciphertext: delivered.ciphertext,
      promise: {
        seller: PAY_TO as Hex,
        value: '1000',
        paymentNonce: `0x${'d'.repeat(64)}`,
        keyHash: promised.keyHash,
        plaintextHash: keccak256(toBytes('{"answer":"the promised one"}')),
        ciphertextHash: delivered.ciphertextHash,
        expiry: '9999999999',
        buyer: PAYER as Hex,
      },
      sellerSignature: '0x',
    }
    const sealedPorts: SealedPorts = {
      coverageFor: () => Promise.resolve(true),
      readBox: () => Promise.resolve({ kind: 'box', box }),
      requestKey: () => Promise.resolve(null),
      claim: () => Promise.resolve({ claimId: CLAIM_ID, deadline: 100n, fromBlock: 1n, transactionHash: CLAIM_TX }),
      readKey: () => Promise.resolve(path === 'fraud' ? { key: promised.key, block: 7n } : null),
      chainTime: () => Promise.resolve(200n),
      wrongKeyRejected: () => false,
      finalize,
      prove: () => Promise.resolve(1000n),
      withdraw: () => Promise.resolve(1000n),
    }
    const ports: DemoPorts = {
      holdAvailable: () => Promise.resolve(1_000_000n),
      growHold: () => Promise.resolve(),
      prepare: () =>
        Promise.resolve({
          accept: { scheme: 'exact', network: 'eip155:5042002', amount: '1000', asset: '0x', payTo: PAY_TO, extra: { recovery: 'same-payment' } },
          amount: DEMO_PRICE,
          nonce: `0x${'d'.repeat(64)}`,
          payer: PAYER,
          header: { name: 'PAYMENT-SIGNATURE', value: 'h' },
          send: () => Promise.resolve(new Response('{"sealed":{}}')),
        }),
      confirmOnePayment: () => Promise.resolve(true),
      countPayments: () => Promise.resolve(0),
      sealed: sealedPorts,
      sealedPollMs: 1,
      ...(verdict ? { verdict } : {}),
    }
    const seller = { name: 'Seller D', url: 'http://s/d', address: PAY_TO }
    const demos = createDemoService(ports, { a: seller, b: seller, d: seller, e: seller, f: seller }, receipts)
    return { demos, receipts }
  }

  async function stopped(demos: ReturnType<typeof setup>['demos']): Promise<DemoRunView> {
    const started = demos.start('d')
    await demos.settled(started.id)
    return demos.get(started.id) as DemoRunView
  }

  test('finalize writes "silent" against the payTo, with the claim transaction', async () => {
    const rulings: Parameters<NonNullable<DemoPorts['verdict']>>[0][] = []
    const { demos } = setup('silent', (r) => rulings.push(r))
    const run = await stopped(demos)
    expect(run.action).toBe('finalize')
    expect(rulings).toHaveLength(0)
    await demos.act(run.id, 'finalize')
    expect(rulings).toEqual([{ claimId: CLAIM_ID, payTo: PAY_TO, verdict: 'silent', claimTx: CLAIM_TX }])
  })

  test('prove writes "fraud", and the swapped answer does not count as a delivery', async () => {
    const rulings: Parameters<NonNullable<DemoPorts['verdict']>>[0][] = []
    const { demos, receipts } = setup('fraud', (r) => rulings.push(r))
    const run = await stopped(demos)
    expect(run.action).toBe('prove')
    expect(keptPromise(receipts.list()[0] as ReceiptRow)).toBe(false)
    await demos.act(run.id, 'prove')
    expect(rulings).toEqual([{ claimId: CLAIM_ID, payTo: PAY_TO, verdict: 'fraud', claimTx: CLAIM_TX }])
  })

  test('wired as server/index.ts wires it, the ruling lands on Arkiv under the payTo, with the contract and the chain', async () => {
    const { wire, calls } = fakeWire()
    const sink = createArkivSink({
      wire,
      store: memoryStore(),
      sellerTtlSeconds: 604800,
      log: () => undefined,
      scrub: createScrubber([]),
      payToOf: payToByName({ 'Seller D': PAY_TO }),
    })
    const { demos } = setup('silent', verdictToArkiv(sink, CONTRACT, 5042002), undefined, sink.store)
    const run = await stopped(demos)
    await demos.act(run.id, 'finalize')
    await sink.idle()

    const verdicts = calls.flatMap((c) => (c.op === 'verdict' ? [c.values] : []))
    expect(verdicts).toEqual([
      {
        kind: 'verdict',
        claim_id: CLAIM_ID,
        seller: PAY_TO_LOWER,
        verdict: 'silent',
        claim_tx: CLAIM_TX,
        contract: CONTRACT.toLowerCase(),
        chain_id: 5042002n,
      },
    ])
  })

  test('a verdict writer that throws does not undo the ruling on screen', async () => {
    const { demos, receipts } = setup('silent', () => {
      throw new Error('queue full')
    })
    const run = await stopped(demos)
    const after = await demos.act(run.id, 'finalize')
    expect(after.action).toBe('withdraw')
    expect(receipts.list()[0]?.outcome?.at(-1)).toBe('Detail: The seller stayed silent. Its deposit paid 0.001 USDC back.')
  })

  test('a finalize that fails writes no ruling, and the button stays', async () => {
    const rulings: unknown[] = []
    // A reverted transaction, or one with no Silent event, throws before any ruling exists.
    const { demos } = setup('silent', (r) => rulings.push(r), () => Promise.reject(new Error('Finalize left no event')))
    const run = await stopped(demos)
    await expect(demos.act(run.id, 'finalize')).rejects.toThrow()
    expect(rulings).toHaveLength(0)
    expect(demos.get(run.id)?.action).toBe('finalize')
  })
})
