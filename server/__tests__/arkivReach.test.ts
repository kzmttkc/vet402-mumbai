import { describe, expect, test } from 'bun:test'
import { custom } from 'viem'
import type { Hex } from 'viem'
import {
  createArkivReadWire,
  createRulingGate,
  createScrubber,
  createSellerCheck,
  payToByName,
  RULED_AGAINST,
  UNREADABLE,
} from '../arkiv'
import type { ArkivWire, EntityOptions, EvidenceValues, ReceiptValues, SellerId, SellerRead, SellerValues } from '../arkiv'
import type { Candidate } from '../discovery'
import { createJobService } from '../jobs'
import type { JobPorts } from '../jobs'
import { SELLER_C_NAME } from '../sellers'
import type { Plan } from '../planner'
import { createTryJob } from '../tryJob'
import type { TryJobPorts } from '../tryJob'
import { arkivWriterFromEnv, readOnlySellerCheck } from '../tryJobWire'
import { tryRecordFromEnv } from '../tryDisputeWire'
import { isRuledAgainst, rulingQuery } from '../../packages/sealed-delivery/src/index'
import { memoryStore } from './helpers'

// Arkiv is a fake here. Nothing leaves this machine.

const RULED = '0x1401Bd7C7FAb3FE8A429672Fc1C5371456c8445d'
const CLEAN = '0x00000000000000000000000000000000000000c1'
const SELLER_A = '0x00000000000000000000000000000000000000a1'
const WRITER = '0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5'

const read = (over: Partial<SellerRead> = {}): SellerRead => ({
  sellerLive: false,
  paymentBlocks: [],
  verdictBlocks: [],
  currentBlock: 1_000_000n,
  blockSeconds: 2,
  ...over,
})

/** A wire that holds one ruling, against RULED, written 10 blocks ago. Every read is kept. */
function rulingWire(failing = false) {
  const asked: SellerId[] = []
  const wire: Pick<ArkivWire, 'readSeller'> = {
    readSeller(seller) {
      asked.push(seller)
      if (failing) return Promise.reject(new Error('429'))
      const addresses = [seller.payTo, seller.rulingAddress].flatMap((a) => (a ? [a.toLowerCase()] : []))
      return Promise.resolve(read({ verdictBlocks: addresses.includes(RULED.toLowerCase()) ? [999_990n] : [] }))
    },
  }
  return { wire, asked }
}

const candidate = (sellerName: string, amount: bigint, payTo: string | null, matchText = 'prices'): Candidate => ({
  resource: `https://${sellerName.toLowerCase().replace(/\s/g, '')}.example.com/data`,
  method: 'GET',
  sellerName,
  category: 'FINANCIAL_ANALYSIS',
  amount,
  path: '/data',
  payTo,
  sealedBy: null,
  bodySchema: null,
  matchText,
})

const jobPorts = (candidates: Candidate[]): JobPorts => ({
  candidates: () => Promise.resolve(candidates),
  latestReceipt: () => Promise.resolve(null),
  holdAvailable: () => Promise.resolve(1_000_000n),
  pay: () => Promise.reject(new Error('not used')),
  findTransfer: () => Promise.resolve(null),
  fetchTransfer: () => Promise.reject(new Error('not used')),
})

describe('A ruling stops a catalog seller by the payTo its listing names', () => {
  test('the catalog seller ruled against at its payTo is passed over, and the note says Arc ruled', async () => {
    const { wire, asked } = rulingWire()
    const check = createSellerCheck(wire, () => undefined, createScrubber([]))
    const service = createJobService(jobPorts([candidate('Cheap', 1000n, RULED), candidate('Dear', 2000n, CLEAN)]), memoryStore(), undefined, {
      sellerCheck: check,
    })
    const view = await service.plan('find prices')
    expect(view.sellerName).toBe('Dear')
    expect(view.notices).toEqual([`Cheap: ${RULED_AGAINST}`])
    // The delivery record is still found by name. Only the rulings are read by the listing's address.
    expect(asked).toContainEqual({ name: 'Cheap', payTo: null, rulingAddress: RULED })
  })

  test('one name listed under two addresses is stopped when either address was ruled against', async () => {
    const { wire } = rulingWire()
    const check = createSellerCheck(wire, () => undefined, createScrubber([]))
    const service = createJobService(
      jobPorts([candidate('Twice', 1000n, CLEAN), { ...candidate('Twice', 1000n, RULED), resource: 'https://twice.example.com/other' }, candidate('Dear', 5000n, CLEAN)]),
      memoryStore(),
      undefined,
      { sellerCheck: check },
    )
    const view = await service.plan('find prices')
    expect(view.sellerName).toBe('Dear')
  })

  test('a pick below the five front runners is read before it is offered, and a ruling stops it too', async () => {
    const asked: string[] = []
    const check = (name: string, payTo?: string | null) => {
      asked.push(name)
      if (payTo === RULED) return Promise.resolve({ kind: 'expired', line: RULED_AGAINST } as const)
      return Promise.resolve(name.startsWith('Gone') ? ({ kind: 'expired', line: UNREADABLE } as const) : ({ kind: 'first', line: 'First purchase from this seller.' } as const))
    }
    const gone = [1, 2, 3, 4, 5].map((n) => candidate(`Gone ${n}`, BigInt(n), CLEAN))
    const service = createJobService(jobPorts([...gone, candidate('Sixth', 100n, RULED), candidate('Seventh', 200n, CLEAN)]), memoryStore(), undefined, {
      sellerCheck: check,
    })
    const view = await service.plan('find prices')
    expect(view.sellerName).toBe('Seventh')
    expect(asked).toContain('Sixth')
    expect(asked).toContain('Seventh')
  })

  test('the Seller C scene reads the next listing by its payTo as well', async () => {
    const { wire } = rulingWire()
    const sellerCPlan: Plan = {
      kind: 'lookup',
      sellerName: SELLER_C_NAME,
      summary: 'Takes care of this job for you.',
      amount: 1000n,
      request: { url: 'http://127.0.0.1:3001/sellers/c', method: 'GET' },
    }
    // Seller C has payments and no live record, so it is not paid. The cheapest listing is ruled against at its payTo.
    const check = createSellerCheck(
      {
        readSeller: (seller) =>
          seller.name === SELLER_C_NAME ? Promise.resolve(read({ paymentBlocks: [1n] })) : wire.readSeller(seller),
      },
      () => undefined,
      createScrubber([]),
    )
    const service = createJobService(
      jobPorts([candidate('Cheap', 1000n, RULED, 'other words'), candidate('Next', 3000n, CLEAN, 'other words')]),
      memoryStore(),
      undefined,
      { sellerCheck: check, sellerCPlan },
    )
    const view = await service.planSellerScene()
    expect(view.sellerName).toBe('Next')
    expect(view.notices).toContain(`Cheap: ${RULED_AGAINST}`)
  })
})

describe('A ruling stops vet402 own demo sellers (A to F) before the demo pays', () => {
  const payToOf = payToByName({ 'Seller A': SELLER_A, 'Seller F': RULED })

  test('Buy from Seller F is refused by Arc ruling, read from Arkiv by the address Seller F is paid at', async () => {
    const { wire, asked } = rulingWire()
    const gate = createRulingGate(wire, () => undefined, createScrubber([]), payToOf)
    expect(await gate('Seller F')).toBe(`Seller F: ${RULED_AGAINST}`)
    expect(asked).toEqual([{ name: 'Seller F', payTo: RULED }])
  })

  test('a seller with no ruling may be paid, even with no delivery on record, because that is its scene', async () => {
    const gate = createRulingGate({ readSeller: () => Promise.resolve(read({ paymentBlocks: [1n] })) }, () => undefined, createScrubber([]), payToOf)
    expect(await gate('Seller A')).toBeNull()
  })

  test('an unreadable Arkiv refuses the demo too, and the log carries no key', async () => {
    const logs: string[] = []
    const gate = createRulingGate(
      { readSeller: () => Promise.reject(new Error('https://rpc/secret answered 429')) },
      (m) => logs.push(m),
      createScrubber(['secret']),
      payToOf,
    )
    expect(await gate('Seller F')).toBe(`Seller F: ${UNREADABLE}`)
    expect(logs.join()).not.toContain('secret')
  })

  test('a ruling older than 7 days no longer refuses', async () => {
    const gate = createRulingGate(
      { readSeller: () => Promise.resolve(read({ verdictBlocks: [1_000_000n - 302_400n] })) },
      () => undefined,
      createScrubber([]),
      payToOf,
    )
    expect(await gate('Seller F')).toBeNull()
  })
})

describe('The real client reads rulings by both addresses', () => {
  test('vet402 own address and the listing address each get a verdict query, filtered on the writer', async () => {
    const queries: string[] = []
    const transport = custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'arkiv_getBlockTiming') return Promise.resolve({ current_block: 1_000_000, current_block_time: 1_793_000_000, duration: 2 })
        queries.push((params as [string])[0])
        return Promise.resolve({ blockNumber: '0xf4240', data: [] })
      },
    })
    const wire = createArkivReadWire({ writer: WRITER, transport })
    await wire.readSeller({ name: 'Seller F', payTo: SELLER_A, rulingAddress: RULED })
    const verdicts = queries.filter((q) => q.includes('vet402_verdict'))
    expect(verdicts).toHaveLength(2)
    expect(verdicts.some((q) => q.includes(SELLER_A.toLowerCase()))).toBe(true)
    expect(verdicts.some((q) => q.includes(RULED.toLowerCase()))).toBe(true)
    for (const q of queries) expect(q.toLowerCase()).toContain(`$owner = addr(${WRITER.toLowerCase()})`)
  })
})

describe('The public try-job reads Arkiv before it picks', () => {
  test('the writer comes from ARKIV_WRITER_ADDRESS, or from the key when the deploy has it, and nothing else', () => {
    expect(arkivWriterFromEnv({})).toBeNull()
    expect(arkivWriterFromEnv({ ARKIV_WRITER_ADDRESS: 'nope' })).toBeNull()
    expect(arkivWriterFromEnv({ ARKIV_WRITER_ADDRESS: WRITER })).toBe(WRITER)
    expect(readOnlySellerCheck({})).toBeNull()
    expect(typeof readOnlySellerCheck({ ARKIV_WRITER_ADDRESS: WRITER })).toBe('function')
  })

  test('a listing Arc ruled against is not picked, and the card says why', async () => {
    const { wire } = rulingWire()
    const ports: TryJobPorts = {
      candidates: () => Promise.resolve([candidate('Cheap', 1000n, RULED), candidate('Dear', 2000n, CLEAN)]),
      latestReceipt: () => Promise.resolve(null),
      holdAvailable: () => Promise.resolve(1_000_000n),
      pay: () => Promise.reject(new Error('not used')),
      findTransfer: () => Promise.resolve(null),
      ownTransfer: () => Promise.resolve(null),
      recentPayments: () => Promise.resolve([]),
      sellerCheck: createSellerCheck(wire, () => undefined, createScrubber([])),
      log: () => {},
    }
    const reply = await createTryJob(ports, { secret: 's' }).plan('find prices', '1.1.1.1')
    expect(reply.ok && reply.value.ok ? reply.value.plan.sellerName : null).toBe('Dear')
    expect(reply.ok && reply.value.ok ? reply.value.plan.notices : null).toEqual([`Cheap: ${RULED_AGAINST}`])
  })

  test('when Arkiv cannot be read, nobody is paid', async () => {
    const { wire } = rulingWire(true)
    const ports: TryJobPorts = {
      candidates: () => Promise.resolve([candidate('Cheap', 1000n, CLEAN)]),
      latestReceipt: () => Promise.resolve(null),
      holdAvailable: () => Promise.resolve(1_000_000n),
      pay: () => Promise.reject(new Error('must not pay')),
      findTransfer: () => Promise.resolve(null),
      ownTransfer: () => Promise.resolve(null),
      recentPayments: () => Promise.resolve([]),
      sellerCheck: createSellerCheck(wire, () => undefined, createScrubber([])),
      log: () => {},
    }
    const reply = await createTryJob(ports, { secret: 's' }).plan('find prices', '1.1.1.1')
    expect(reply.ok && !reply.value.ok ? reply.value.code : null).toBe('NO_SELLER')
  })
})

describe('The public try-dispute writes to Arkiv only with the writer key', () => {
  const deps = { sealedAddress: CLEAN as Hex, seller: SELLER_A as Hex, findTransfer: () => Promise.resolve(null) }

  test('without ARKIV_WRITER_KEY there is no record and no Swarm upload', () => {
    expect(tryRecordFromEnv({}, deps)).toBeNull()
    expect(tryRecordFromEnv({ ARKIV_WRITER_KEY: 'nope' }, deps)).toBeNull()
  })

  test('with it, a row with a transfer id and a Swarm reference becomes payment, seller and evidence entities', async () => {
    const written: { op: string; values: ReceiptValues | SellerValues | EvidenceValues }[] = []
    const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
    const arkivWire: ArkivWire = {
      createReceipt: (values: ReceiptValues, _o: EntityOptions) => (written.push({ op: 'receipt', values }), Promise.resolve({ entityKey: key(written.length) })),
      createSeller: (values: SellerValues) => (written.push({ op: 'seller', values }), Promise.resolve({ entityKey: key(written.length) })),
      createEvidence: (values: EvidenceValues) => (written.push({ op: 'evidence', values }), Promise.resolve({ entityKey: key(written.length) })),
      createVerdict: () => Promise.reject(new Error('not used')),
      extendEntity: () => Promise.reject(new Error('not used')),
      findPaymentKey: () => Promise.resolve(null),
      findSellerKey: () => Promise.resolve(null),
      findEvidenceKey: () => Promise.resolve(null),
      findVerdictKey: () => Promise.resolve(null),
      readSeller: () => Promise.reject(new Error('not used')),
    }
    const uploads: Uint8Array[] = []
    const kept = tryRecordFromEnv(
      { ARKIV_WRITER_KEY: `0x${'1'.repeat(64)}` },
      { ...deps, arkivWire, swarm: { upload: (data) => (uploads.push(data), Promise.resolve('ab'.repeat(32))), download: () => Promise.reject(new Error('not used')) } },
    )
    expect(kept).not.toBeNull()
    const store = memoryStore()
    const wrapped = kept!.record.wrap(store)
    wrapped.store.add({
      id: 'try',
      at: new Date().toISOString(),
      amount: '1000',
      sellerName: 'Seller A',
      responseHash: 'f'.repeat(64),
      responseBytes: 10,
      timesReceived: 1,
      transferId: null,
      nonce: `0x${'d'.repeat(64)}`,
      status: 'received',
      batchTx: null,
      outcome: ['Charged once. Key read from Arc.'],
      sealed: { ciphertext: '0x00', claimId: `0x${'c'.repeat(64)}`, plaintextHash: `0x${'1'.repeat(64)}`, keyBlock: '7' },
      evidence: { claimId: `0x${'c'.repeat(64)}`, swarmRef: 'ab'.repeat(32) },
    })
    await wrapped.idle()
    expect(written).toEqual([])
    wrapped.store.update('try', { transferId: 'transfer-1', status: 'received' })
    await wrapped.idle()
    expect(written.map((w) => w.op)).toEqual(['receipt', 'seller', 'evidence'])
    expect((written[0]!.values as ReceiptValues).pay_to).toBe(SELLER_A)
    expect((written[2]!.values as EvidenceValues).swarm_ref).toBe('ab'.repeat(32))

    // The box goes to the public gateway's wire. It holds the ciphertext and the claim, never a key.
    await kept!.evidence(
      { ciphertext: '0x00', promise: { plaintextHash: `0x${'1'.repeat(64)}`, ciphertextHash: `0x${'2'.repeat(64)}` } } as never,
      `0x${'c'.repeat(64)}`,
    )
    expect(uploads).toHaveLength(1)
    expect(new TextDecoder().decode(uploads[0])).not.toContain('key')
  })
})

describe('Any x402 buyer can read the rulings: isRuledAgainst', () => {
  const node = (rows: { createdAt: number }[], calls: string[] = []) =>
    (async (_url: string, init: RequestInit) => {
      const { method, params } = JSON.parse(init.body as string) as { method: string; params: [string] }
      calls.push(method === 'arkiv_query' ? params[0] : method)
      const result =
        method === 'arkiv_getBlockTiming'
          ? { current_block: 1_000_000, current_block_time: 1, duration: 2 }
          : { data: rows.map((r) => ({ key: '0x01', createdAt: `0x${r.createdAt.toString(16)}` })) }
      return new Response(JSON.stringify({ result }))
    }) as unknown as typeof fetch

  test('true for a ruling in the last 7 days, false for an older one or none, filtered on the writer', async () => {
    const calls: string[] = []
    expect(await isRuledAgainst(RULED, { writer: WRITER, fetch: node([{ createdAt: 999_000 }], calls) })).toBe(true)
    expect(await isRuledAgainst(RULED, { writer: WRITER, fetch: node([{ createdAt: 1_000_000 - 302_400 }]) })).toBe(false)
    expect(await isRuledAgainst(RULED, { writer: WRITER, fetch: node([]) })).toBe(false)
    expect(calls[1]).toBe(rulingQuery(RULED, WRITER))
    expect(calls[1]).toContain(`seller = str('${RULED.toLowerCase()}')`)
    expect(calls[1]).toContain(`$owner = addr(${WRITER})`)
  })

  test('a failed read throws, so the buyer decides', async () => {
    const down = (() => Promise.resolve(new Response('busy', { status: 429 }))) as unknown as typeof fetch
    await expect(isRuledAgainst(RULED, { writer: WRITER, fetch: down })).rejects.toThrow('429')
    expect(() => rulingQuery('nope', WRITER)).toThrow()
  })
})
