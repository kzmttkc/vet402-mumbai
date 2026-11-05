import { describe, expect, test } from 'bun:test'
import { encodeFunctionResult, keccak256 } from 'viem'
import type { Hex } from 'viem'
import { createArkivSink, createScrubber } from '../arkiv'
import type { ArkivWire, EntityOptions, EvidenceValues } from '../arkiv'
import { createDemoService } from '../demo'
import type { DemoPorts, DemoRunView } from '../demo'
import type { ReceiptRow } from '../receiptStore'
import type { SealedBox, SealedPorts } from '../sealedDelivery'
import { DEMO_PRICE } from '../sellers'
import { createEvidenceUploader } from '../swarm'
import {
  BOX_NOT_THIS_CLAIM,
  CLAIMS_ABI,
  DOES_NOT_MATCH_PROMISE,
  FROM_ARC,
  FROM_ARKIV,
  FROM_SWARM,
  MATCHES_PROMISE,
  openFromRecord,
} from '../../src/lib/openSealed'
import type { PublicSealedAnswer } from '../../src/lib/openSealed'
import { sealResponse } from '../../src/lib/sealed'
import { encodeBox, readBox } from '../../src/lib/swarmBox'
import type { EvidenceBox, SwarmWire } from '../../src/lib/swarmBox'
import { memoryStore } from './helpers'

// Swarm, Arkiv and Arc are all fakes here. Nothing leaves this machine.

const CONTRACT = `0x${'c1'.repeat(20)}`
const CLAIM_ID: Hex = `0x${'c2'.repeat(32)}`
const REF = 'ab'.repeat(32)
const ANSWER = '{"answer":"Here is the answer you paid for."}'
const sealed = sealResponse(ANSWER)

function fakeSwarm(fail = false) {
  const kept = new Map<string, Uint8Array>()
  const swarm: SwarmWire = {
    upload: (data) => {
      if (fail) return Promise.reject(new Error('gateway down'))
      kept.set(REF, data)
      return Promise.resolve(REF)
    },
    download: (reference) => {
      const data = kept.get(reference)
      return data ? Promise.resolve(data) : Promise.reject(new Error('404'))
    },
  }
  return { swarm, kept }
}

const box: SealedBox = {
  ciphertext: sealed.ciphertext,
  promise: {
    seller: `0x${'aa'.repeat(20)}`,
    value: '1000',
    paymentNonce: `0x${'d'.repeat(64)}`,
    keyHash: sealed.keyHash,
    plaintextHash: sealed.plaintextHash,
    ciphertextHash: sealed.ciphertextHash,
    expiry: '9999999999',
    buyer: `0x${'bb'.repeat(20)}`,
  },
  sellerSignature: '0x',
}

describe('the box on Swarm', () => {
  test('holds the ciphertext, the claim, both hashes, the contract and the chain, and no key', async () => {
    const { swarm, kept } = fakeSwarm()
    const upload = createEvidenceUploader({ swarm, contract: CONTRACT, chainId: 5042002 })
    expect(await upload(box, CLAIM_ID)).toBe(REF)
    const sent = JSON.parse(new TextDecoder().decode(kept.get(REF))) as Record<string, unknown>
    expect(sent).toEqual({
      ciphertext: sealed.ciphertext,
      claimId: CLAIM_ID,
      plaintextHash: sealed.plaintextHash,
      ciphertextHash: sealed.ciphertextHash,
      contract: CONTRACT,
      chainId: 5042002,
    })
    expect(JSON.stringify(sent)).not.toContain(sealed.key.slice(2))
  })

  test('a box for another claim, contract or chain, or with a changed ciphertext, is not used', () => {
    const good: EvidenceBox = {
      ciphertext: sealed.ciphertext,
      claimId: CLAIM_ID,
      plaintextHash: sealed.plaintextHash,
      ciphertextHash: sealed.ciphertextHash,
      contract: CONTRACT,
      chainId: 5042002,
    }
    const expected = { claimId: CLAIM_ID, contract: CONTRACT.toUpperCase().replace('0X', '0x'), chainId: 5042002 }
    expect(readBox(encodeBox(good), expected)).toEqual(good)
    expect(readBox(encodeBox(good), { ...expected, claimId: `0x${'c3'.repeat(32)}` })).toBeNull()
    expect(readBox(encodeBox(good), { ...expected, contract: `0x${'c4'.repeat(20)}` })).toBeNull()
    expect(readBox(encodeBox(good), { ...expected, chainId: 1 })).toBeNull()
    const other = sealResponse('something else')
    expect(readBox(encodeBox({ ...good, ciphertext: other.ciphertext }), expected)).toBeNull()
    expect(readBox(new TextEncoder().encode('<!doctype html>'), expected)).toBeNull()
  })
})

describe('the evidence entity on Arkiv', () => {
  const row = (over: Partial<ReceiptRow> = {}): ReceiptRow => ({
    id: 'row-1',
    at: new Date(Date.now() + 1000).toISOString(),
    amount: '1000',
    sellerName: 'Seller A',
    responseHash: 'f'.repeat(64),
    responseBytes: 42,
    timesReceived: 1,
    transferId: 'transfer-1',
    nonce: null,
    status: 'received',
    batchTx: null,
    ...over,
  })

  function wire(over: Partial<ArkivWire> = {}) {
    const evidence: { values: EvidenceValues; options: EntityOptions }[] = []
    const ops: string[] = []
    let n = 0
    const key = () => `0x${String(++n).padStart(64, '0')}` as Hex
    const w: ArkivWire = {
      createReceipt: () => {
        ops.push('receipt')
        return Promise.resolve({ entityKey: key() })
      },
      createSeller: () => {
        ops.push('seller')
        return Promise.resolve({ entityKey: key() })
      },
      createEvidence: (values, options) => {
        ops.push('evidence')
        evidence.push({ values, options })
        return Promise.resolve({ entityKey: key() })
      },
      extendEntity: () => {
        ops.push('extend')
        return Promise.resolve({ expiresAt: 1n })
      },
      findPaymentKey: () => Promise.resolve(null),
      findSellerKey: () => Promise.resolve(null),
      findEvidenceKey: () => Promise.resolve(null),
      readSeller: () => Promise.reject(new Error('not used')),
      ...over,
    }
    return { w, evidence, ops }
  }

  const sinkFor = (w: ArkivWire, logs: string[] = []) => {
    const inner = memoryStore()
    const made = createArkivSink({ wire: w, store: inner, sellerTtlSeconds: 604800, log: (m) => logs.push(m), scrub: createScrubber([]) })
    return { ...made, inner }
  }

  test('is a new readonly entity with the claim, the transfer and the plain reference, after the payment', async () => {
    const { w, evidence, ops } = wire()
    const { store, idle, inner } = sinkFor(w)
    store.add(row())
    await idle()
    store.update('row-1', { evidence: { claimId: CLAIM_ID, swarmRef: REF } })
    await idle()
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.values).toEqual({ kind: 'evidence', claim_id: CLAIM_ID, gateway_transfer_id: 'transfer-1', swarm_ref: REF })
    expect(evidence[0]?.options.flags).toEqual({ readonly: true, permissionlessExtension: true })
    expect(ops).toEqual(['receipt', 'seller', 'evidence'])
    expect(inner.list()[0]?.arkivEvidenceKey).toMatch(/^0x/)
    // Written once: a later change to the row does not write it again.
    store.update('row-1', { status: 'batched' })
    await idle()
    expect(evidence).toHaveLength(1)
  })

  test('waits for the transfer id, and a failed write looks first before writing again', async () => {
    let tries = 0
    let found: Hex | null = null
    const { w, evidence } = wire({
      createEvidence: () => {
        tries++
        if (tries === 1) {
          found = `0x${'e'.repeat(64)}`
          return Promise.reject(new Error('timeout'))
        }
        return Promise.resolve({ entityKey: `0x${'f'.repeat(64)}` as Hex })
      },
      findEvidenceKey: () => Promise.resolve(found),
    })
    const logs: string[] = []
    const { store, idle, inner, sweep } = sinkFor(w, logs)
    store.add(row({ transferId: null, evidence: { claimId: CLAIM_ID, swarmRef: REF } }))
    await idle()
    expect(tries).toBe(0)
    store.update('row-1', { transferId: 'transfer-1' })
    await idle()
    expect(tries).toBe(1)
    expect(logs.some((m) => m.startsWith('Arkiv write failed'))).toBe(true)
    sweep()
    await idle()
    expect(tries).toBe(1)
    expect(inner.list()[0]?.arkivEvidenceKey).toBe(`0x${'e'.repeat(64)}`)
    expect(evidence).toHaveLength(0)
  })
})

describe('the demo keeps the claimed box on Swarm', () => {
  const PAYER = '0xAbCdEf0000000000000000000000000000000002'

  function setup(evidence: DemoPorts['evidence']) {
    const sealedPorts: SealedPorts = {
      coverageFor: () => Promise.resolve(true),
      readBox: () => Promise.resolve({ kind: 'box', box }),
      requestKey: () => Promise.resolve(null),
      claim: () => Promise.resolve({ claimId: CLAIM_ID, deadline: 100n, fromBlock: 1n }),
      readKey: () => Promise.resolve({ key: sealed.key, block: 7n }),
      chainTime: () => Promise.resolve(50n),
      wrongKeyRejected: () => false,
      finalize: () => Promise.resolve(1000n),
      prove: () => Promise.resolve(1000n),
      withdraw: () => Promise.resolve(1000n),
    }
    const ports: DemoPorts = {
      holdAvailable: () => Promise.resolve(1_000_000n),
      growHold: () => Promise.resolve(),
      prepare: () =>
        Promise.resolve({
          accept: { scheme: 'exact', network: 'eip155:5042002', amount: '1000', asset: '0x', payTo: PAYER, extra: { recovery: 'same-payment' } },
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
      ...(evidence ? { evidence } : {}),
    }
    const seller = { name: 'Seller A', url: 'http://s/a', address: PAYER }
    const receipts = memoryStore()
    const demos = createDemoService(ports, { a: seller, b: seller, d: seller, e: seller, f: seller }, receipts)
    return { demos, receipts }
  }

  const run = async (demos: ReturnType<typeof setup>['demos']) => {
    const started = demos.start('a')
    await demos.settled(started.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    return demos.get(started.id) as DemoRunView
  }

  test('after the claim, the reference lands on the receipt row', async () => {
    const { swarm } = fakeSwarm()
    const { demos, receipts } = setup(createEvidenceUploader({ swarm, contract: CONTRACT, chainId: 5042002 }))
    const finished = await run(demos)
    expect(finished.state).toBe('done')
    expect(receipts.list()[0]?.evidence).toEqual({ claimId: CLAIM_ID, swarmRef: REF })
    expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Key read from Arc.', 'Circle record: 1 transfer for this payment.'])
  })

  test('a failed upload changes nothing about the claim or the receipt', async () => {
    const { swarm } = fakeSwarm(true)
    const { demos, receipts } = setup(createEvidenceUploader({ swarm, contract: CONTRACT, chainId: 5042002 }))
    const finished = await run(demos)
    expect(finished.state).toBe('done')
    expect(finished.steps.map((s) => s.name)).toContain('delivered')
    expect(receipts.list()[0]?.evidence).toBeUndefined()
    expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Key read from Arc.', 'Circle record: 1 transfer for this payment.'])
  })

  test('an upload that never answers does not hold up the run', async () => {
    const { demos, receipts } = setup(() => new Promise<string>(() => {}))
    const finished = await run(demos)
    expect(finished.state).toBe('done')
    expect(receipts.list()[0]?.evidence).toBeUndefined()
  })
})

describe('the published screen opens the answer from Arkiv, Swarm and Arc', () => {
  const answer: PublicSealedAnswer = {
    ref: 'r0',
    sellerName: 'Seller A',
    ciphertext: sealed.ciphertext,
    claimId: CLAIM_ID,
    plaintextHash: sealed.plaintextHash,
    keyBlock: '255',
  }
  const keyLog = (key: Hex) => {
    const data = `0x${'0'.repeat(62)}20${(key.length / 2 - 1).toString(16).padStart(64, '0')}${key.slice(2).padEnd(64, '0')}`
    return [{ data }]
  }
  /** What the contract stored when the buyer claimed. By default, the honest box. */
  const HONEST = { plaintextHash: sealed.plaintextHash, ciphertextHash: sealed.ciphertextHash }
  const claimRecord = (hashes: { plaintextHash: Hex; ciphertextHash: Hex }) =>
    encodeFunctionResult({
      abi: CLAIMS_ABI,
      functionName: 'claims',
      result: [`0x${'aa'.repeat(20)}`, `0x${'bb'.repeat(20)}`, 1000n, 100n, sealed.keyHash, 2, `0x${'d'.repeat(64)}`, hashes.plaintextHash, hashes.ciphertextHash],
    })
  /** Arc: eth_getLogs gives the revealed key, eth_call gives the claim's stored hashes. */
  const arc = (key: Hex | null, hashes: { plaintextHash: Hex; ciphertextHash: Hex } = HONEST, calls: string[] = []) =>
    (async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string }
      calls.push(method)
      const result = method === 'eth_call' ? claimRecord(hashes) : key ? keyLog(key) : []
      return new Response(JSON.stringify({ result }))
    }) as unknown as typeof fetch
  const swarmBox = (over: Partial<EvidenceBox> = {}) =>
    encodeBox({
      ciphertext: sealed.ciphertext,
      claimId: CLAIM_ID,
      plaintextHash: sealed.plaintextHash,
      ciphertextHash: sealed.ciphertextHash,
      contract: CONTRACT,
      chainId: 5042002,
      ...over,
    })

  test('reads Arkiv, then Swarm, then Arc, and says so one line each', async () => {
    const order: string[] = []
    const result = await openFromRecord(
      { ...answer, ciphertext: '0x00' },
      CONTRACT,
      {
        readEvidence: (claimId) => {
          order.push(`arkiv ${claimId === CLAIM_ID}`)
          return Promise.resolve(REF)
        },
        downloadBox: (reference) => {
          order.push(`swarm ${reference === REF}`)
          return Promise.resolve(swarmBox())
        },
      },
      { fetchImpl: arc(sealed.key, HONEST, order) },
    )
    expect(order).toEqual(['arkiv true', 'swarm true', 'eth_getLogs', 'eth_call'])
    expect(result).toEqual({ ok: true, text: ANSWER, matches: true, line: MATCHES_PROMISE, read: [FROM_ARKIV, FROM_SWARM, FROM_ARC] })
    expect([FROM_ARKIV, FROM_SWARM, FROM_ARC]).toEqual(['Record from Arkiv.', 'Box from Swarm.', 'Key from Arc.'])
  })

  test('the box from Swarm is what gets opened, so a swapped answer shows', async () => {
    const lie = sealResponse('This is not what the seller promised.')
    const result = await openFromRecord(
      answer,
      CONTRACT,
      {
        readEvidence: () => Promise.resolve(REF),
        downloadBox: () =>
          Promise.resolve(swarmBox({ ciphertext: lie.ciphertext, ciphertextHash: keccak256(lie.ciphertext) })),
      },
      // The seller promised the real answer and the buyer claimed with the box that holds the lie.
      { fetchImpl: arc(lie.key, { plaintextHash: sealed.plaintextHash, ciphertextHash: lie.ciphertextHash }) },
    )
    expect(result).toMatchObject({ ok: true, matches: false, line: DOES_NOT_MATCH_PROMISE, read: [FROM_ARKIV, FROM_SWARM, FROM_ARC] })
  })

  test('a fake gateway that returns a forged plaintext, ciphertext and hashes together never gets a match', async () => {
    // Once the key is on Arc anyone can seal any text with it, and make every hash in the box agree.
    const forged = sealResponse('{"answer":"Forged by the gateway."}', sealed.key)
    const forgedBox = swarmBox({ ciphertext: forged.ciphertext, ciphertextHash: forged.ciphertextHash, plaintextHash: forged.plaintextHash })
    const sources = { readEvidence: () => Promise.resolve(REF), downloadBox: () => Promise.resolve(forgedBox) }
    const result = await openFromRecord(answer, CONTRACT, sources, { fetchImpl: arc(sealed.key) })
    expect(result).toEqual({ ok: false, line: BOX_NOT_THIS_CLAIM, read: [FROM_ARKIV, FROM_SWARM] })
    expect(BOX_NOT_THIS_CLAIM).toBe('This box is not the one claimed on Arc.')

    // The real ciphertext with a forged promise: the hash on Arc decides, so a lying seller still shows.
    const lie = sealResponse('This is not what the seller promised.')
    const relabelled = swarmBox({ ciphertext: lie.ciphertext, ciphertextHash: lie.ciphertextHash, plaintextHash: lie.plaintextHash })
    const lied = await openFromRecord(
      answer,
      CONTRACT,
      { readEvidence: () => Promise.resolve(REF), downloadBox: () => Promise.resolve(relabelled) },
      { fetchImpl: arc(lie.key, { plaintextHash: sealed.plaintextHash, ciphertextHash: lie.ciphertextHash }) },
    )
    expect(lied).toMatchObject({ ok: true, matches: false, line: DOES_NOT_MATCH_PROMISE })
  })

  test('the exported file is held to the same record on Arc', async () => {
    const noRecord = { readEvidence: () => Promise.resolve(null) }
    // A forged file box, with every hash in it agreeing.
    const forged = sealResponse('{"answer":"Forged in the file."}', sealed.key)
    const forgedFile = await openFromRecord(
      { ...answer, ciphertext: forged.ciphertext, plaintextHash: forged.plaintextHash },
      CONTRACT,
      noRecord,
      { fetchImpl: arc(sealed.key) },
    )
    expect(forgedFile).toEqual({ ok: false, line: BOX_NOT_THIS_CLAIM, read: [] })

    // A file that relabels a lying seller's box as kept: the hash on Arc still says it was not.
    const lie = sealResponse('This is not what the seller promised.')
    const relabelled = await openFromRecord(
      { ...answer, ciphertext: lie.ciphertext, plaintextHash: keccak256(new TextEncoder().encode('This is not what the seller promised.')) },
      CONTRACT,
      noRecord,
      { fetchImpl: arc(lie.key, { plaintextHash: sealed.plaintextHash, ciphertextHash: lie.ciphertextHash }) },
    )
    expect(relabelled).toMatchObject({ ok: true, matches: false, line: DOES_NOT_MATCH_PROMISE, read: [FROM_ARC] })

    // A Swarm failure falls back to the file, and the file is checked the same way.
    const swarmDown = await openFromRecord(
      { ...answer, ciphertext: forged.ciphertext, plaintextHash: forged.plaintextHash },
      CONTRACT,
      { readEvidence: () => Promise.resolve(REF), downloadBox: () => Promise.reject(new Error('404')) },
      { fetchImpl: arc(sealed.key) },
    )
    expect(swarmDown).toEqual({ ok: false, line: BOX_NOT_THIS_CLAIM, read: [FROM_ARKIV] })
  })

  test('no Arkiv record, a Swarm failure or a wrong box fall back to the exported file', async () => {
    const none = await openFromRecord(answer, CONTRACT, { readEvidence: () => Promise.resolve(null) }, { fetchImpl: arc(sealed.key) })
    expect(none).toMatchObject({ ok: true, matches: true, read: [FROM_ARC] })

    const arkivDown = await openFromRecord(answer, CONTRACT, { readEvidence: () => Promise.reject(new Error('rpc')) }, { fetchImpl: arc(sealed.key) })
    expect(arkivDown).toMatchObject({ ok: true, matches: true, read: [FROM_ARC] })

    const swarmDown = await openFromRecord(
      answer,
      CONTRACT,
      { readEvidence: () => Promise.resolve(REF), downloadBox: () => Promise.reject(new Error('404')) },
      { fetchImpl: arc(sealed.key) },
    )
    expect(swarmDown).toMatchObject({ ok: true, matches: true, read: [FROM_ARKIV, FROM_ARC] })

    const wrongBox = await openFromRecord(
      answer,
      CONTRACT,
      { readEvidence: () => Promise.resolve(REF), downloadBox: () => Promise.resolve(swarmBox({ chainId: 1 })) },
      { fetchImpl: arc(sealed.key) },
    )
    expect(wrongBox).toMatchObject({ ok: true, matches: true, read: [FROM_ARKIV, FROM_ARC] })

    const noSources = await openFromRecord(answer, CONTRACT, {}, { fetchImpl: arc(sealed.key) })
    expect(noSources).toMatchObject({ ok: true, matches: true, read: [FROM_ARC] })
  })

  test('no key on Arc ends as before, with the lines that were read', async () => {
    const result = await openFromRecord(
      answer,
      CONTRACT,
      { readEvidence: () => Promise.resolve(REF), downloadBox: () => Promise.resolve(swarmBox()) },
      { fetchImpl: arc(null) },
    )
    expect(result).toEqual({ ok: false, line: 'Could not read the key.', read: [FROM_ARKIV, FROM_SWARM] })
  })

  test('the lines use no semicolons or dashes', () => {
    for (const line of [FROM_ARKIV, FROM_SWARM, FROM_ARC]) expect(line).not.toMatch(/[;–—-]/)
  })
})
