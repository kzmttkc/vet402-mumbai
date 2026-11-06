import { beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NULL_STAMP } from '@ethersphere/bee-js'
import type { Hex } from 'viem'
import { createArkivSink, createScrubber } from '../arkiv'
import type { ArkivWire, EvidenceValues } from '../arkiv'
import { AnswerName } from '../../src/components/OpenSealed'
import { keptOnSwarmLine, openableAnswers } from '../../src/lib/openSealed'
import { createSwarmWire, swarmKeptUntil } from '../../src/lib/swarmBox'
import type { BeeApi } from '../../src/lib/swarmBox'
import { memoryStore } from './helpers'

// Z2: a box vet402's own Bee node uploads is pinned there, and its postage batch says how long Swarm
// keeps it. The date reaches the box's evidence entity and then the "Open a sealed answer" screen.

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).__ARKIV_WRITER__ = ''
})

const OWN_BATCH = 'f1'.repeat(32)
const NOW_MS = Date.UTC(2026, 10, 6, 0, 0, 0)
const DAY = 86_400

let uploads = 0

/** A Bee API that records each call. Every upload gets a new reference, and the batch has 40 days left. */
function fakeBee({ ttlSeconds = 40 * DAY, pinFails = false } = {}) {
  const calls: string[] = []
  const bee = {
    data: {
      upload: async (batch: unknown) => {
        calls.push(`upload ${String(typeof batch === 'string' ? batch : (batch as { toHex(): string }).toHex()).slice(0, 4)}`)
        const hex = String(++uploads).padStart(64, '0')
        return { reference: { toHex: () => hex } }
      },
      download: async () => ({ toUint8Array: () => new Uint8Array() }),
    },
    pin: {
      add: async (reference: string) => {
        calls.push(`pin ${reference.slice(-2)}`)
        if (pinFails) throw new Error('pin refused')
      },
    },
    stamp: {
      get: async (batch: string) => {
        calls.push(`stamp ${batch.slice(0, 4)}`)
        return { duration: { toSeconds: () => ttlSeconds } }
      },
    },
  } as unknown as BeeApi
  return { bee, calls }
}

describe('Z2: a box from your own Bee node is pinned, and its batch says how long Swarm keeps it', () => {
  test('the upload pins the box and records when its postage batch runs out', async () => {
    const { bee, calls } = fakeBee()
    const wire = createSwarmWire('http://127.0.0.1:1633', 1000, OWN_BATCH, { bee, now: () => NOW_MS })
    const reference = await wire.upload(new Uint8Array([1]))

    expect(calls).toEqual(['upload f1f1', `pin ${reference.slice(-2)}`, 'stamp f1f1'])
    const until = swarmKeptUntil.get(reference)
    expect(until).toBe(NOW_MS / 1000 + 40 * DAY)
    expect(keptOnSwarmLine(until as number)).toBe('Kept on Swarm until 2026-12-16')
  })

  test('the public gateway stamps with its own batch, so its wire pins nothing and records no date', async () => {
    const { bee, calls } = fakeBee()
    const wire = createSwarmWire(undefined, 1000, NULL_STAMP, { bee, now: () => NOW_MS })
    const reference = await wire.upload(new Uint8Array([2]))

    expect(calls).toEqual(['upload 0000'])
    expect(wire.keep).toBeUndefined()
    expect(swarmKeptUntil.has(reference)).toBe(false)
  })

  test('a failed pin keeps the upload and leaves the date out', async () => {
    const { bee } = fakeBee({ pinFails: true })
    const wire = createSwarmWire('http://127.0.0.1:1633', 1000, OWN_BATCH, { bee, now: () => NOW_MS })
    const reference = await wire.upload(new Uint8Array([3]))
    expect(reference).toMatch(/^[0-9a-f]{64}$/)
    expect(swarmKeptUntil.has(reference)).toBe(false)
  })

  test('the date goes into the evidence entity on Arkiv, read from what the upload recorded', async () => {
    const { bee } = fakeBee()
    const reference = await createSwarmWire('http://127.0.0.1:1633', 1000, OWN_BATCH, { bee, now: () => NOW_MS }).upload(new Uint8Array([4]))
    const written: EvidenceValues[] = []
    let n = 0
    const key = () => `0x${String(++n).padStart(64, '0')}` as Hex
    const wire: ArkivWire = {
      createReceipt: () => Promise.resolve({ entityKey: key() }),
      createSeller: () => Promise.resolve({ entityKey: key() }),
      createEvidence: (values) => (written.push(values), Promise.resolve({ entityKey: key() })),
      createVerdict: () => Promise.reject(new Error('not used')),
      extendEntity: () => Promise.reject(new Error('not used')),
      findPaymentKey: () => Promise.resolve(null),
      findSellerKey: () => Promise.resolve(null),
      findEvidenceKey: () => Promise.resolve(null),
      findVerdictKey: () => Promise.resolve(null),
      readSeller: () => Promise.reject(new Error('not used')),
    }
    const sink = createArkivSink({ wire, store: memoryStore(), sellerTtlSeconds: 604800, log: () => undefined, scrub: createScrubber([]) })
    sink.store.add({
      id: 'r1',
      at: new Date(Date.now() + 1000).toISOString(),
      amount: '1000',
      sellerName: 'Seller D',
      responseHash: 'f'.repeat(64),
      responseBytes: 1,
      timesReceived: 0,
      transferId: 'transfer-1',
      nonce: null,
      status: 'received',
      batchTx: null,
      evidence: { claimId: `0x${'c'.repeat(64)}`, swarmRef: reference },
    })
    await sink.idle()
    expect(written[0]?.swarm_kept_until).toBe(BigInt(NOW_MS / 1000 + 40 * DAY))
  })
})

describe('Z2: what "Open a sealed answer" shows', () => {
  const file = {
    contract: `0x${'c1'.repeat(20)}`,
    answers: [
      { ref: 'own', sellerName: 'Seller D', claimId: `0x${'d'.repeat(64)}`, keyBlock: '1' },
      { ref: 'gw', sellerName: 'Seller A', claimId: `0x${'a'.repeat(64)}`, keyBlock: '2' },
    ],
  }
  const evidence = [
    { claimId: `0x${'d'.repeat(64)}`, swarmRef: '1'.repeat(64), keptUntil: Date.UTC(2026, 11, 16) / 1000 },
    { claimId: `0x${'a'.repeat(64)}`, swarmRef: '2'.repeat(64) },
  ]

  test('a box from your own node shows the day Swarm keeps it until', () => {
    const [own] = openableAnswers(file, evidence)
    const html = renderToStaticMarkup(<AnswerName answer={own!} />)
    expect(html).toContain('Seller D')
    expect(html).toContain('Kept on Swarm until 2026-12-16')
  })

  test('a box the public gateway stamped shows the seller alone, with no sentence about a date', () => {
    const [, gateway] = openableAnswers(file, evidence)
    expect(gateway?.keptUntil).toBeUndefined()
    const html = renderToStaticMarkup(<AnswerName answer={gateway!} />)
    expect(html).toContain('Seller A')
    expect(html).not.toContain('Swarm')
    expect(html).not.toMatch(/\bnot\b|\bno\b|unknown/i)
  })
})
