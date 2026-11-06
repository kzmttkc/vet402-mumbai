import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { predictEntityKey } from '@arkiv-network/sdk'
import { custom, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, parseAbiParameters, parseTransaction } from 'viem'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { batchLine, createArkivSink, createArkivWire, createScrubber, handedOverLine } from '../arkiv'
import type { ArkivWire, EvidenceValues, VerdictRecord } from '../arkiv'
import { KEY_FROM_CHAIN } from '../demo'
import type { ReceiptRow } from '../receiptStore'
import { createEvidenceLister, createEvidenceReader } from '../../src/arkiv/readArkiv'
import { DETAIL_PREFIX } from '../../src/lib/receiptLines'
import { memoryStore } from './helpers'

// The client waits for each receipt as it would on Rabdi, so a test that sends three transactions takes a few seconds.
setDefaultTimeout(20_000)

// A fake Arkiv node behind the real client: every JSON-RPC call the SDK makes is answered here, and
// every transaction it signs is decoded back into its operations. Nothing reaches the network.

const WRITER_KEY = `0x${'a'.repeat(64)}` as const
const WRITER = privateKeyToAccount(WRITER_KEY).address
const BUYER = `0x${'b0'.repeat(20)}` as Hex
const ARKIV_ADDRESS = '0x4400000000000000000000000000000000000044'
const CLAIM_ID = `0x${'c'.repeat(64)}`
const REF = 'ab'.repeat(32)

const EXECUTE = parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)'])
const EVENTS = parseAbi([
  'event EntityCreated(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags)',
  'event ExpiryExtended(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt)',
  'event OwnershipTransferred(bytes32 indexed entityKey, address indexed previousOwner, address indexed newOwner)',
])
const CREATE = parseAbiParameters('(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)')
const TRANSFER = parseAbiParameters('(bytes32 entityKey, address newOwner)')

interface SentOp {
  kind: 'create' | 'extend' | 'transfer' | 'other'
  key?: Hex
  newOwner?: string
  creationFlags?: number
}

/**
 * `reject` decides, per batch, whether the engine reverts it. A reverted batch applies nothing.
 * `nonceSkew` makes another write from the same account land between the prediction and the batch.
 */
function fakeNode({ reject = () => false, nonceSkew = 0n }: { reject?: (ops: SentOp[]) => boolean; nonceSkew?: bigint } = {}) {
  let chainId = 0
  let nonce = 0n
  let txCount = 0
  const sent: SentOp[][] = []
  const queries: string[] = []
  const receipts = new Map<string, { ops: SentOp[]; ok: boolean }>()
  const existing = new Set<Hex>()
  const owners = new Map<string, string>()

  function decode(data: Hex, atNonce: bigint): SentOp[] {
    const { args } = decodeFunctionData({ abi: EXECUTE, data })
    let n = atNonce
    return (args[0] as readonly { operation: number; operationData: Hex }[]).map(({ operation, operationData }) => {
      if (operation === 1) {
        const [create] = decodeAbiParameters(CREATE, operationData)
        return { kind: 'create', key: predictEntityKey({ owner: WRITER, nonce: n++, salt: create.salt, chainId }), creationFlags: create.creationFlags }
      }
      if (operation === 4) {
        const [transfer] = decodeAbiParameters(TRANSFER, operationData)
        return { kind: 'transfer', key: transfer.entityKey, newOwner: transfer.newOwner }
      }
      return { kind: operation === 3 ? 'extend' : 'other' }
    })
  }

  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[]
      switch (method) {
        case 'eth_chainId':
          return `0x${chainId.toString(16)}`
        case 'eth_blockNumber':
          return '0x64'
        case 'eth_getTransactionCount':
          return `0x${txCount.toString(16)}`
        case 'eth_estimateGas':
          return '0x30000'
        case 'eth_maxPriorityFeePerGas':
        case 'eth_gasPrice':
          return '0x1'
        case 'eth_getBlockByNumber':
          return { number: '0x64', baseFeePerGas: '0x1', timestamp: '0x1', hash: `0x${'1'.repeat(64)}`, transactions: [] }
        case 'eth_call': {
          const call = p[0] as { data: Hex }
          // entityNonce(address) has one word of arguments. execute(...) is the revert reason read.
          if (call.data.length <= 10 + 64) return encodeAbiParameters([{ type: 'uint64' }], [nonce])
          throw new Error('execution reverted')
        }
        case 'eth_sendRawTransaction': {
          const tx = parseTransaction(p[0] as Hex)
          txCount++
          nonce += nonceSkew
          const ops = decode(tx.data as Hex, nonce)
          sent.push(ops)
          const created = ops.filter((o) => o.kind === 'create').map((o) => o.key)
          // The engine reverts a hand over of a key that does not exist.
          const handsOverUnknown = ops.some((o) => o.kind === 'transfer' && !created.includes(o.key) && !existing.has(o.key as Hex))
          const ok = !reject(ops) && !handsOverUnknown
          if (ok) {
            nonce += BigInt(created.length)
            for (const k of created) existing.add(k as Hex)
            for (const k of created) owners.set(k as string, WRITER)
            for (const o of ops) if (o.kind === 'transfer') owners.set(o.key as string, o.newOwner as string)
          }
          const hash = keccak256(p[0] as Hex)
          receipts.set(hash, { ops, ok })
          return hash
        }
        case 'eth_getTransactionReceipt':
        case 'eth_getTransactionByHash': {
          const hash = p[0] as Hex
          const found = receipts.get(hash)
          if (!found) return null
          if (method === 'eth_getTransactionByHash') return { hash, gas: '0x30000', blockNumber: '0x65', from: WRITER, to: ARKIV_ADDRESS, input: '0x', nonce: '0x0', value: '0x0', type: '0x2', chainId: `0x${chainId.toString(16)}` }
          const logs = found.ok
            ? found.ops.flatMap((op, i) => {
                const base = { address: ARKIV_ADDRESS, blockHash: `0x${'2'.repeat(64)}`, blockNumber: '0x65', transactionHash: hash, transactionIndex: '0x0', logIndex: `0x${i.toString(16)}`, removed: false }
                if (op.kind === 'create')
                  return [{ ...base, topics: encodeEventTopics({ abi: EVENTS, eventName: 'EntityCreated', args: { entityKey: op.key, owner: WRITER } }), data: encodeAbiParameters(parseAbiParameters('uint64, uint8'), [1000n, op.creationFlags ?? 0]) }]
                if (op.kind === 'extend')
                  return [{ ...base, topics: encodeEventTopics({ abi: EVENTS, eventName: 'ExpiryExtended', args: { entityKey: `0x${'e'.repeat(64)}`, owner: WRITER } }), data: encodeAbiParameters(parseAbiParameters('uint64'), [2000n]) }]
                if (op.kind === 'transfer')
                  return [{ ...base, topics: encodeEventTopics({ abi: EVENTS, eventName: 'OwnershipTransferred', args: { entityKey: op.key, previousOwner: WRITER, newOwner: op.newOwner as Hex } }), data: '0x' }]
                return []
              })
            : []
          return { transactionHash: hash, status: found.ok ? '0x1' : '0x0', gasUsed: '0x100', blockNumber: '0x65', blockHash: `0x${'2'.repeat(64)}`, transactionIndex: '0x0', from: WRITER, to: ARKIV_ADDRESS, cumulativeGasUsed: '0x100', effectiveGasPrice: '0x1', logs, logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', contractAddress: null }
        }
        case 'arkiv_getEntity': {
          const key = String(p[0])
          const owner = owners.get(key)
          if (!owner) return null
          return { key, owner, creator: WRITER, createdAt: '0x65', updatedAt: '0x65', expiresAt: '0x1000', creationFlags: { readonly: true, permissionlessExtension: true, raw: 3 }, attributes: [] }
        }
        case 'arkiv_query':
          queries.push(String(p[0]))
          return { data: [], blockNumber: '0x64' }
        default:
          throw new Error(`unexpected ${method}`)
      }
    },
  })
  return {
    transport,
    sent,
    queries,
    ownerOf: (key: string) => owners.get(key),
    setChain: (id: number) => {
      chainId = id
    },
  }
}

/** A Seller A row from the try: paid, answered with the key from Arc, and its box on Swarm. */
const disputeRow = (over: Partial<ReceiptRow> = {}): ReceiptRow => ({
  id: 'try-1',
  at: new Date(Date.now() + 1000).toISOString(),
  amount: '1000',
  sellerName: 'Seller A',
  responseHash: 'f'.repeat(64),
  responseBytes: 42,
  timesReceived: 1,
  transferId: 'transfer-1',
  nonce: `0x${'1'.repeat(64)}`,
  status: 'received',
  batchTx: null,
  outcome: [KEY_FROM_CHAIN],
  sealed: { ciphertext: '0x00', claimId: CLAIM_ID, plaintextHash: `0x${'0'.repeat(64)}`, keyBlock: '1' },
  evidence: { claimId: CLAIM_ID, swarmRef: REF },
  ...over,
})

function realSink(node: ReturnType<typeof fakeNode>, owner: Hex | null = BUYER) {
  const { wire, writer } = createArkivWire({ writerKey: WRITER_KEY, accessKey: '', transport: node.transport })
  const inner = memoryStore()
  const logs: string[] = []
  const sink = createArkivSink({
    wire,
    store: inner,
    sellerTtlSeconds: 604800,
    log: (m) => logs.push(m),
    scrub: createScrubber([]),
    payToOf: () => `0x${'5e'.repeat(20)}`,
    evidenceOwner: owner,
    writer,
    keptUntilOf: () => null,
  })
  return { ...sink, inner, logs }
}

const details = (row: ReceiptRow | undefined) =>
  (row?.outcome ?? []).filter((line) => line.startsWith(DETAIL_PREFIX)).map((line) => line.slice(DETAIL_PREFIX.length))

async function chainId() {
  const { rabdi } = await import('@arkiv-network/sdk/chains')
  return rabdi({ accessKey: '' }).id
}

describe('K1: one dispute, one Arkiv transaction', () => {
  test('the payment, seller and evidence entities go in one executeBatch transaction, and Details says so', async () => {
    const node = fakeNode()
    node.setChain(await chainId())
    const { store, idle, inner, logs } = realSink(node)
    store.add(disputeRow())
    await idle()

    expect(logs).toEqual([])
    // One signed transaction for the whole row.
    expect(node.sent).toHaveLength(1)
    const ops = node.sent[0] as SentOp[]
    expect(ops.filter((o) => o.kind === 'create')).toHaveLength(3)
    const row = inner.list()[0]
    expect(row?.arkivPaymentKey).toBe(ops[0]?.key)
    expect(row?.arkivSellerDone).toBe(true)
    expect(row?.arkivEvidenceKey).toBe(ops[2]?.key)
    expect(details(row)).toContain(batchLine(3))
    expect(batchLine(3)).toBe('Arkiv: 1 transaction, 3 entities')
  })

  test('all or nothing: a reverted batch leaves no key on the row, and nothing is written one by one', async () => {
    const node = fakeNode({ reject: () => true })
    node.setChain(await chainId())
    const { store, idle, inner, logs } = realSink(node)
    store.add(disputeRow())
    await idle()

    // The first batch carried the hand over. It goes once more without it, and that one reverts too.
    expect(node.sent).toHaveLength(2)
    expect(node.sent.every((ops) => ops.filter((o) => o.kind === 'create').length === 3)).toBe(true)
    const row = inner.list()[0]
    expect(row?.arkivPaymentKey).toBeUndefined()
    expect(row?.arkivSellerDone).toBeUndefined()
    expect(row?.arkivEvidenceKey).toBeUndefined()
    expect(details(row)).toEqual([])
    expect(logs.some((m) => m.startsWith('Arkiv write failed'))).toBe(true)
  })

  test('a ruling on the same claim rides in the same transaction as a fourth entity', async () => {
    const node = fakeNode()
    node.setChain(await chainId())
    const { store, idle, inner, recordVerdict } = realSink(node)
    store.add(disputeRow({ transferId: null }))
    await idle()
    const ruling: VerdictRecord = { claimId: CLAIM_ID as Hex, payTo: `0x${'5e'.repeat(20)}`, verdict: 'silent', contract: `0x${'c1'.repeat(20)}`, chainId: 5042002 }
    // The ruling waits behind the row, which is written once Gateway gives the transfer id.
    store.update('try-1', { transferId: 'transfer-1' })
    recordVerdict(ruling)
    await idle()

    expect(node.sent).toHaveLength(1)
    expect((node.sent[0] as SentOp[]).filter((o) => o.kind === 'create')).toHaveLength(4)
    expect(details(inner.list()[0])).toContain(batchLine(4))
  })
})

describe('K2: the evidence entity belongs to the buyer, and the ruling stays with vet402', () => {
  test('the hand over is in the same transaction, and it names the evidence entity and the buyer', async () => {
    const node = fakeNode()
    node.setChain(await chainId())
    const { store, idle, inner } = realSink(node)
    store.add(disputeRow())
    await idle()

    const ops = node.sent[0] as SentOp[]
    const transfers = ops.filter((o) => o.kind === 'transfer')
    expect(transfers).toHaveLength(1)
    expect(transfers[0]?.key).toBe(inner.list()[0]?.arkivEvidenceKey as Hex)
    expect(transfers[0]?.newOwner?.toLowerCase()).toBe(BUYER.toLowerCase())
    // readonly is a creation flag, set on the create and kept for life. The hand over does not touch it.
    expect((ops[2]?.creationFlags ?? 0) & 1).toBe(1)
    expect(details(inner.list()[0])).toContain(handedOverLine(BUYER))
  })

  test('the verdict entity is never handed over', async () => {
    const node = fakeNode()
    node.setChain(await chainId())
    const { store, idle, recordVerdict } = realSink(node)
    store.add(disputeRow({ transferId: null }))
    await idle()
    store.update('try-1', { transferId: 'transfer-1' })
    recordVerdict({ claimId: CLAIM_ID as Hex, payTo: `0x${'5e'.repeat(20)}`, verdict: 'fraud', contract: `0x${'c1'.repeat(20)}`, chainId: 5042002 })
    await idle()

    const ops = node.sent[0] as SentOp[]
    const creates = ops.filter((o) => o.kind === 'create')
    const transfers = ops.filter((o) => o.kind === 'transfer')
    expect(transfers.map((t) => t.key)).toEqual([creates[2]?.key])
    expect(transfers.map((t) => t.key)).not.toContain(creates[3]?.key)
  })

  test('when another write moved the predicted key, the batch lands without the hand over, which follows on its own', async () => {
    const node = fakeNode({ nonceSkew: 1n })
    node.setChain(await chainId())
    const { store, idle, inner, logs } = realSink(node)
    store.add(disputeRow())
    await idle()

    expect(node.sent).toHaveLength(3)
    expect(node.sent[1]?.some((o) => o.kind === 'transfer')).toBe(false)
    const alone = node.sent[2] as SentOp[]
    expect(alone).toEqual([{ kind: 'transfer', key: inner.list()[0]?.arkivEvidenceKey as Hex, newOwner: alone[0]?.newOwner }])
    expect(alone[0]?.newOwner?.toLowerCase()).toBe(BUYER.toLowerCase())
    expect(node.ownerOf(inner.list()[0]?.arkivEvidenceKey as string)?.toLowerCase()).toBe(BUYER.toLowerCase())
    expect(details(inner.list()[0])).toEqual([batchLine(3), handedOverLine(BUYER)])
    expect(logs.some((m) => m.startsWith('Arkiv batch failed, sending it again'))).toBe(true)
  })

  test('no hand over to the writer itself, or without a buyer', async () => {
    for (const owner of [WRITER, null]) {
      const node = fakeNode()
      node.setChain(await chainId())
      const { store, idle, inner } = realSink(node, owner)
      store.add(disputeRow())
      await idle()
      expect(node.sent).toHaveLength(1)
      expect(node.sent[0]?.some((o) => o.kind === 'transfer')).toBe(false)
      expect(details(inner.list()[0])).toEqual([batchLine(3)])
    }
  })

  test('every evidence read filters on the creator, so a handed over entity is still found as vet402 wrote it', async () => {
    const node = fakeNode()
    node.setChain(await chainId())
    const { wire } = createArkivWire({ writerKey: WRITER_KEY, accessKey: '', transport: node.transport })
    await wire.findEvidenceKey(CLAIM_ID)
    await createEvidenceReader(WRITER, node.transport)(CLAIM_ID)
    await createEvidenceLister(WRITER, node.transport)()

    expect(node.queries).toHaveLength(3)
    for (const query of node.queries) {
      expect(query.toLowerCase()).toContain(`$creator = addr(${WRITER.toLowerCase()})`)
      expect(query).not.toContain('$owner =')
    }
  })

  test('the lister hands back the owner and the Swarm date of each entity', async () => {
    const attr = (name: string, type: string, value: string) => ({ name, type, value })
    const transport = custom({
      request: ({ method }: { method: string }) => {
        if (method !== 'arkiv_query') return Promise.reject(new Error(`unexpected ${method}`))
        return Promise.resolve({
          data: [
            {
              key: `0x${'1'.repeat(64)}`,
              owner: BUYER,
              attributes: [
                attr('arkiv.schema', 'str', 'vet402_evidence'),
                attr('claim_id', 'str', CLAIM_ID),
                attr('swarm_ref', 'str', REF),
                attr('swarm_kept_until', 'u64', '0x6943a400'),
              ],
            },
          ],
          blockNumber: '0x1',
        })
      },
    })
    const listed = await createEvidenceLister(WRITER, transport)()
    expect(listed.map((e) => ({ ...e, owner: e.owner?.toLowerCase() }))).toEqual([{ claimId: CLAIM_ID, swarmRef: REF, keptUntil: 0x6943a400, owner: BUYER }])
  })
})

describe('a batch that landed although the call failed', () => {
  test('is not sent again, and an evidence entity the buyer already owns is not handed over twice', async () => {
    const landed = { payment: null as Hex | null, evidence: null as Hex | null }
    let batches = 0
    let handOvers = 0
    const wire: ArkivWire = {
      createReceipt: () => Promise.reject(new Error('not used')),
      createSeller: () => Promise.reject(new Error('not used')),
      createEvidence: () => Promise.reject(new Error('not used')),
      createVerdict: () => Promise.reject(new Error('not used')),
      extendEntity: () => Promise.reject(new Error('not used')),
      // The transaction lands with the hand over, and the answer is lost on the way back.
      writeBatch: async (batch) => {
        batches++
        if (batches > 1) {
          // The retry carries nothing the first one landed: only the seller's extension.
          expect(batch.payment).toBeUndefined()
          expect(batch.evidence).toBeUndefined()
          return { handedOver: false, sellerKey: `0x${'2'.repeat(64)}` }
        }
        landed.payment = `0x${'1'.repeat(64)}`
        landed.evidence = `0x${'3'.repeat(64)}`
        throw new Error('timeout')
      },
      changeOwner: async () => {
        handOvers++
        return { txHash: `0x${'9'.repeat(64)}` }
      },
      evidenceOwner: async () => BUYER,
      findPaymentKey: async () => landed.payment,
      findSellerKey: async () => (landed.payment ? `0x${'2'.repeat(64)}` : null),
      findEvidenceKey: async () => landed.evidence,
      findVerdictKey: async () => null,
      readSeller: () => Promise.reject(new Error('not used')),
    }
    const inner = memoryStore()
    const logs: string[] = []
    const sink = createArkivSink({ wire, store: inner, sellerTtlSeconds: 604800, log: (m) => logs.push(m), scrub: createScrubber([]), evidenceOwner: BUYER, writer: WRITER })
    sink.store.add(disputeRow())
    await sink.idle()
    expect(batches).toBe(1)
    expect(logs.some((m) => m.startsWith('Arkiv write failed'))).toBe(true)

    sink.sweep()
    await sink.idle()
    const row = inner.list()[0]
    expect(row?.arkivPaymentKey).toBe(landed.payment as string)
    expect(row?.arkivEvidenceKey).toBe(landed.evidence as string)
    // The seller entity the batch made is found, so the retry only extends it.
    expect(batches).toBe(2)
    expect(handOvers).toBe(0)
    expect(details(row)).toContain(handedOverLine(BUYER))
  })
})

describe('the wire contract a fake can follow', () => {
  test('a wire without writeBatch still writes every entity, one by one, and claims no single transaction', async () => {
    const ops: string[] = []
    let n = 0
    const key = () => `0x${String(++n).padStart(64, '0')}` as Hex
    const evidence: EvidenceValues[] = []
    const wire: ArkivWire = {
      createReceipt: () => (ops.push('receipt'), Promise.resolve({ entityKey: key() })),
      createSeller: () => (ops.push('seller'), Promise.resolve({ entityKey: key() })),
      createEvidence: (values) => (ops.push('evidence'), evidence.push(values), Promise.resolve({ entityKey: key() })),
      createVerdict: () => Promise.reject(new Error('not used')),
      extendEntity: () => Promise.reject(new Error('not used')),
      findPaymentKey: () => Promise.resolve(null),
      findSellerKey: () => Promise.resolve(null),
      findEvidenceKey: () => Promise.resolve(null),
      findVerdictKey: () => Promise.resolve(null),
      readSeller: () => Promise.reject(new Error('not used')),
    }
    const inner = memoryStore()
    const sink = createArkivSink({
      wire,
      store: inner,
      sellerTtlSeconds: 604800,
      log: () => undefined,
      scrub: createScrubber([]),
      keptUntilOf: (ref) => (ref === REF ? 1_797_206_400 : null),
    })
    sink.store.add(disputeRow())
    await sink.idle()
    expect(ops).toEqual(['receipt', 'seller', 'evidence'])
    expect(details(inner.list()[0])).toEqual([])
    // A box from vet402's own Bee node carries its Swarm date into the evidence entity.
    expect(evidence[0]?.swarm_kept_until).toBe(1_797_206_400n)
  })
})
