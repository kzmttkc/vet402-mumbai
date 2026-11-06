import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk'
import type { CreateEntityParameters } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { asc, eq } from '@arkiv-network/sdk/query'
import { u64 } from '@arkiv-network/sdk/schema'
import type { CreateEntityValues, Schema } from '@arkiv-network/sdk/schema'
import { http } from 'viem'
import { isAddressEqual, zeroAddress } from 'viem'
import type { Hex, Transport } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { PAGE_SIZE, readAllPages } from '../src/arkiv/pages'
import {
  addressColumn,
  EvidenceSchema,
  ReceiptSchema,
  sellerColumn,
  SellerSchema,
  VerdictSchema,
} from '../src/arkiv/schema'
import type { ReceiptRow, ReceiptStore } from './receiptStore'
import { KEY_FROM_CHAIN } from './demo'
import { detail } from '../src/lib/receiptLines'
import { swarmKeptUntil } from '../src/lib/swarmBox'
import { SELLER_C_NAME } from './sellers'

export const RECEIPT_DAYS = 30
export const SELLER_SECONDS = 604800
export const COUNT_AFTER_SECONDS = 60n
/** A ruling from Arc stops every purchase from that seller for this long, counted from the block it was written in. */
export const VERDICT_SECONDS = 604800n

const READ_TIMEOUT_MS = 5000
const MAX_ATTEMPTS = 5
const SWEEP_ROWS = 20
const BLOCK_SECONDS = 2

export const NOT_PAID = 'No recent delivery from this seller. Not paid.'
export const RULED_AGAINST = 'Arc ruled against this seller in the last 7 days. Not paid.'
export const UNREADABLE = 'Arkiv could not be read, so the delivery check did not run. Not paid.'

/** 'expired' is the one answer that stops the purchase, whichever line says why. A failed read stops it too. */
export type DeliveryCheck =
  | { kind: 'live'; line: 'Delivered recently.' }
  | { kind: 'first'; line: 'First purchase from this seller.' }
  | { kind: 'expired'; line: typeof NOT_PAID | typeof RULED_AGAINST | typeof UNREADABLE }

export interface ReceiptValues {
  kind: 'payment' | 'settlement'
  job_id: string
  seller: string
  amount_micro: bigint
  gateway_transfer_id: string
  response_hash: string
  response_bytes: bigint
  times_received: bigint
  status: 'accepted' | 'settled'
  batch_tx?: string
  payment_key?: string
  pay_to?: string
}

export interface SellerValues {
  kind: 'seller'
  seller: string
  pay_to?: string
}

export type VerdictKind = 'silent' | 'fraud'

export interface VerdictValues {
  kind: 'verdict'
  claim_id: string
  /** The payTo address, lowercase. Kept beside `pay_to`, so readers of older entities still match. */
  seller: string
  /** The payTo address, lowercase, under the name the receipt and seller schemas give it. Every ruling of Arc carries it. */
  pay_to?: string
  verdict: VerdictKind
  claim_tx?: string
  contract: string
  chain_id: bigint
}

/** Arc's ruling on one claim: Silent after finalize, Fraud after prove. */
export interface VerdictRecord {
  claimId: Hex
  /** The address the seller was paid at. */
  payTo: string
  verdict: VerdictKind
  /** The claim's transaction on Arc, when the chain reported it. */
  claimTx?: Hex
  contract: string
  chainId: number
}

/** How a seller is found on Arkiv: by its payTo address when vet402 knows it, by name otherwise. */
export interface SellerId {
  name: string
  /** vet402's own address for this seller. Its delivery record and its rulings are read by it. */
  payTo: string | null
  /**
   * The address a catalog listing says it is paid at. Only Arc's rulings are read by it, never the
   * delivery record, so a listing cannot borrow another seller's record by naming its address.
   */
  rulingAddress?: string | null
}

/** Every address Arc's rulings are read by for this seller, lowercase and without repeats. */
export const rulingAddresses = (seller: SellerId): string[] =>
  [...new Set([seller.payTo, seller.rulingAddress].flatMap((a) => (a ? [addressColumn(a)] : [])))]

/** The payTo address vet402 knows for a seller name, or null. Only vet402's own configuration answers it. */
export type PayToOf = (sellerName: string) => string | null

/** A PayToOf over the sellers vet402 runs itself. Any other name gets null, so it is found by name alone. */
export function payToByName(addresses: Record<string, string>): PayToOf {
  const known = new Map(Object.entries(addresses))
  return (sellerName) => known.get(sellerName) ?? null
}

/** The demo's verdict port: the ruling as the demo reports it, with the contract and chain it was made on. */
export function verdictToArkiv(
  sink: { recordVerdict(record: VerdictRecord): void },
  contract: string,
  chainId: number,
): (ruling: Omit<VerdictRecord, 'contract' | 'chainId'>) => void {
  return (ruling) => sink.recordVerdict({ ...ruling, contract, chainId })
}

export interface EvidenceValues {
  kind: 'evidence'
  claim_id: string
  gateway_transfer_id: string
  swarm_ref: string
  /** Unix seconds the box's postage batch keeps it on Swarm. Only a box from vet402's own Bee node carries it. */
  swarm_kept_until?: bigint
}

export interface EntityOptions {
  expiration: ReturnType<typeof ExpirationTime.fromSeconds>
  flags: { readonly: true; permissionlessExtension?: true }
}

export interface SellerRead {
  sellerLive: boolean
  /** The block each payment entity was created in. */
  paymentBlocks: bigint[]
  /** The block each of Arc's rulings against this payTo address was written in. Empty without an address. */
  verdictBlocks: bigint[]
  currentBlock: bigint
  blockSeconds: number
}

/** One entity to create, with its expiry and flags. */
export interface EntityWrite<V> {
  values: V
  options: EntityOptions
}

/**
 * Everything one receipt row writes in one go. With `writeBatch` it is one Arkiv transaction: every
 * entity lands, or none does. A settlement names its payment entity, so it is only here once that key is known.
 */
export interface BatchWrite {
  payment?: EntityWrite<ReceiptValues>
  seller?: { create: EntityWrite<SellerValues> } | { extend: Hex; expiration: EntityOptions['expiration'] }
  settlement?: EntityWrite<ReceiptValues>
  evidence?: EntityWrite<EvidenceValues>
  verdict?: EntityWrite<VerdictValues>
  /** The buyer on the claim. The evidence entity becomes theirs in the same transaction. */
  evidenceOwner?: Hex
}

export interface BatchResult {
  txHash?: Hex
  paymentKey?: Hex
  sellerKey?: Hex
  settlementKey?: Hex
  evidenceKey?: Hex
  verdictKey?: Hex
  /** True when the evidence entity changed owner in this transaction. */
  handedOver: boolean
}

/** How many entities a batch creates or extends. The ownership change is an operation on the evidence, not another entity. */
export const entitiesIn = (batch: BatchWrite): number =>
  [batch.payment, batch.seller, batch.settlement, batch.evidence, batch.verdict].filter(Boolean).length

/** The line under Details once a row's entities reached Arkiv together. */
export const batchLine = (entities: number): string => `Arkiv: 1 transaction, ${entities} entities`
/** The line under Details once the evidence entity belongs to the buyer. */
export const handedOverLine = (owner: string): string => `Arkiv: the evidence entity belongs to the buyer ${owner.slice(0, 6)}…${owner.slice(-4)}`

/** Everything that touches Arkiv. Tests swap this out, so they never reach the network. */
export interface ArkivWire {
  createReceipt(values: ReceiptValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  createSeller(values: SellerValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  createEvidence(values: EvidenceValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  createVerdict(values: VerdictValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  /** Sets a new expiry. A duration counts from now, it is not added to what is left. */
  extendEntity(params: { entityKey: Hex; expiration: EntityOptions['expiration'] }): Promise<{ expiresAt: bigint }>
  /** Writes a row's entities in one transaction with executeBatch. A wire without it writes them one by one. */
  writeBatch?(batch: BatchWrite): Promise<BatchResult>
  /** Hands one entity to a new owner with changeOwnership. */
  changeOwner?(params: { entityKey: Hex; newOwner: Hex }): Promise<{ txHash: Hex }>
  /** Who owns an evidence entity now, so a hand over that already landed is not sent again. */
  evidenceOwner?(entityKey: Hex): Promise<Hex | null>
  findPaymentKey(transferId: string): Promise<Hex | null>
  findSellerKey(seller: SellerId): Promise<Hex | null>
  findEvidenceKey(claimId: string): Promise<Hex | null>
  findVerdictKey(claimId: string): Promise<Hex | null>
  readSeller(seller: SellerId): Promise<SellerRead>
}

/** Only the short message, with every secret removed. An RPC error's full message carries the URL. */
export function createScrubber(secrets: string[]) {
  const words = secrets.filter(Boolean).flatMap((s) => [s, encodeURIComponent(s)])
  return (error: unknown): string => {
    const raw = error as { shortMessage?: unknown; message?: unknown } | null
    const text = String(raw?.shortMessage ?? raw?.message ?? error)
    return words.reduce((out, word) => out.split(word).join('***'), text)
  }
}

interface WireEnv {
  writerKey: Hex
  accessKey: string
  /** Tests pass a fake transport. The real one is plain HTTP with no retries. */
  transport?: Transport
}

type ReadWire = Pick<ArkivWire, 'findPaymentKey' | 'findSellerKey' | 'findEvidenceKey' | 'findVerdictKey' | 'readSeller'> &
  Required<Pick<ArkivWire, 'evidenceOwner'>>

/** Every read the backend makes, filtered on one writer. No key is involved: reads go to the public RPC. */
function createReads(accessKey: string, writer: Hex, transport?: Transport): ReadWire {
  const reads = createPublicClient({
    chain: rabdi({ accessKey }),
    transport: transport ?? http(undefined, { retryCount: 0, timeout: READ_TIMEOUT_MS }),
  })

  // A known payTo address is the only key used, so a catalog seller cannot borrow another seller's record by its name.
  function sellerEntity(seller: SellerId) {
    const query = reads.select({ $key: true }).from(SellerSchema).where(eq('kind', 'seller'))
    return (seller.payTo ? query.where(eq('pay_to', addressColumn(seller.payTo))) : query.where(eq('seller', sellerColumn(seller.name))))
      .ownedBy(writer)
      .limit(1)
      .fetch()
  }

  const readVerdicts = (payTo: string) =>
    readAllPages((offset) =>
      reads
        .select({ $key: true, $createdAt: true })
        .from(VerdictSchema)
        .where(eq('kind', 'verdict'))
        .where(eq('seller', addressColumn(payTo)))
        .ownedBy(writer)
        .orderBy(asc('$key'))
        .limit(PAGE_SIZE)
        .offset(offset)
        .fetch(),
    )

  return {
    async findPaymentKey(transferId) {
      const { entities } = await reads
        .select({ $key: true })
        .from(ReceiptSchema)
        .where(eq('kind', 'payment'))
        .where(eq('gateway_transfer_id', transferId))
        .ownedBy(writer)
        .limit(1)
        .fetch()
      return entities[0]?.$key ?? null
    },

    // By creator: an evidence entity belongs to the buyer once it is handed over, and vet402 is still the one that wrote it.
    async findEvidenceKey(claimId) {
      const { entities } = await reads
        .select({ $key: true })
        .from(EvidenceSchema)
        .where(eq('kind', 'evidence'))
        .where(eq('claim_id', claimId))
        .createdBy(writer)
        .limit(1)
        .fetch()
      return entities[0]?.$key ?? null
    },

    async findVerdictKey(claimId) {
      const { entities } = await reads
        .select({ $key: true })
        .from(VerdictSchema)
        .where(eq('kind', 'verdict'))
        .where(eq('claim_id', claimId))
        .ownedBy(writer)
        .limit(1)
        .fetch()
      return entities[0]?.$key ?? null
    },

    findSellerKey: async (seller) => (await sellerEntity(seller)).entities[0]?.$key ?? null,

    evidenceOwner: async (entityKey) => ((await reads.getEntity(entityKey)).$owner as Hex | undefined) ?? null,

    async readSeller(seller) {
      const [live, payments, verdicts, timing] = await Promise.all([
        sellerEntity(seller),
        readAllPages((offset) => {
          const query = reads.select({ $key: true, $createdAt: true }).from(ReceiptSchema).where(eq('kind', 'payment'))
          return (seller.payTo ? query.where(eq('pay_to', addressColumn(seller.payTo))) : query.where(eq('seller', sellerColumn(seller.name))))
            .ownedBy(writer)
            .orderBy(asc('$key'))
            .limit(PAGE_SIZE)
            .offset(offset)
            .fetch()
        }),
        // vet402's own address and the address a listing names. Without either there is nothing to read rulings by.
        Promise.all(rulingAddresses(seller).map(readVerdicts)).then((pages) => pages.flat()),
        reads.getBlockTiming(),
      ])
      return {
        sellerLive: live.entities.length > 0,
        paymentBlocks: payments.flatMap((row) => (row.$createdAt === undefined ? [] : [row.$createdAt])),
        verdictBlocks: verdicts.flatMap((row) => (row.$createdAt === undefined ? [] : [row.$createdAt])),
        currentBlock: timing.currentBlock,
        blockSeconds: timing.blockDuration,
      }
    },
  }
}

export function createArkivWire({ writerKey, accessKey, transport }: WireEnv): { wire: ArkivWire; writer: Hex } {
  const chain = rabdi({ accessKey })
  const account = privateKeyToAccount(writerKey)
  const writer = account.address
  // No nonceManager, on purpose: one queue sends one write at a time.
  const writes = createWalletClient({ chain, transport: transport ?? http(), account })
  // Works out the keys the next creates will get, from the writer's entity nonce. A read, so it needs no key.
  const keys = createPublicClient({ chain, transport: transport ?? http(undefined, { retryCount: 0, timeout: READ_TIMEOUT_MS }) })

  return {
    writer,
    wire: {
      ...createReads(accessKey, writer, transport),
      createReceipt: (values, options) => writes.createEntity(ReceiptSchema, receiptColumnsOf(values), options),
      createSeller: (values, options) => writes.createEntity(SellerSchema, values, options),
      createEvidence: (values, options) => writes.createEntity(EvidenceSchema, evidenceColumnsOf(values), options),
      createVerdict: (values, options) => writes.createEntity(VerdictSchema, verdictColumnsOf(values), options),
      extendEntity: (params) => writes.extendEntity(params),
      changeOwner: (params) => writes.changeOwnership(params),

      async writeBatch(batch) {
        const creates: CreateEntityParameters[] = []
        const slot = (write: CreateEntityParameters | null) => (write ? creates.push(write) - 1 : -1)
        const at = {
          payment: slot(batch.payment ? createOf(ReceiptSchema, receiptColumnsOf(batch.payment.values), batch.payment.options) : null),
          seller: slot(batch.seller && 'create' in batch.seller ? createOf(SellerSchema, batch.seller.create.values, batch.seller.create.options) : null),
          settlement: slot(batch.settlement ? createOf(ReceiptSchema, receiptColumnsOf(batch.settlement.values), batch.settlement.options) : null),
          evidence: slot(batch.evidence ? createOf(EvidenceSchema, evidenceColumnsOf(batch.evidence.values), batch.evidence.options) : null),
          verdict: slot(batch.verdict ? createOf(VerdictSchema, verdictColumnsOf(batch.verdict.values), batch.verdict.options) : null),
        }
        // The evidence entity is handed over in the same transaction, so its key is worked out before it exists.
        // A key from another write that landed first would make the whole batch revert, and the sink then hands it over on its own.
        const owner = batch.evidenceOwner && at.evidence >= 0 ? batch.evidenceOwner : null
        let predicted: Hex | null = null
        if (owner) {
          const pairs = await keys.predictEntityKeys({ owner: writer, count: creates.length })
          pairs.forEach((pair, i) => {
            ;(creates[i] as CreateEntityParameters).salt = pair.salt
          })
          predicted = pairs[at.evidence]?.key ?? null
        }
        const extension = batch.seller && 'extend' in batch.seller ? batch.seller : null
        const result = await writes.executeBatch({
          creates,
          ...(extension ? { extensions: [{ entityKey: extension.extend, expiration: extension.expiration }] } : {}),
          ...(owner && predicted ? { ownershipChanges: [{ entityKey: predicted, newOwner: owner }] } : {}),
        })
        const keyAt = (i: number) => (i >= 0 ? result.createdEntities[i] : undefined)
        const evidenceKey = keyAt(at.evidence)
        return {
          txHash: result.txHash,
          ...(keyAt(at.payment) ? { paymentKey: keyAt(at.payment) } : {}),
          ...(keyAt(at.seller) ? { sellerKey: keyAt(at.seller) } : extension ? { sellerKey: extension.extend } : {}),
          ...(keyAt(at.settlement) ? { settlementKey: keyAt(at.settlement) } : {}),
          ...(evidenceKey ? { evidenceKey } : {}),
          ...(keyAt(at.verdict) ? { verdictKey: keyAt(at.verdict) } : {}),
          handedOver: !!owner && !!predicted && evidenceKey?.toLowerCase() === predicted.toLowerCase() && result.ownershipChanges.length === 1,
        }
      },
    },
  }
}

/** One create in a batch, typed by its own schema. The batch holds creates of several schemas. */
const createOf = <S extends Schema>(schema: S, values: CreateEntityValues<S>, options: EntityOptions): CreateEntityParameters =>
  ({ schema, values, ...options }) as unknown as CreateEntityParameters

const receiptColumnsOf = (values: ReceiptValues) => ({
  ...values,
  amount_micro: u64(values.amount_micro),
  response_bytes: u64(values.response_bytes),
  times_received: u64(values.times_received),
})

const evidenceColumnsOf = ({ swarm_kept_until, ...values }: EvidenceValues) => ({
  ...values,
  ...(swarm_kept_until !== undefined ? { swarm_kept_until: u64(swarm_kept_until) } : {}),
})

const verdictColumnsOf = (values: VerdictValues) => ({ ...values, chain_id: u64(values.chain_id) })

/**
 * The reads alone, for a place that holds no writer key, such as the public deploy. It knows only the
 * writer's address, so it can check a seller but never write. The access key is optional: without it
 * the reads go to the public endpoint, which is rate limited.
 */
export function createArkivReadWire({ writer, accessKey = '', transport }: { writer: Hex; accessKey?: string; transport?: Transport }): ReadWire {
  return createReads(accessKey, writer, transport)
}

/** What the screen may do about this seller, given what Arkiv holds for it. */
/** True when Arc ruled against this seller within VERDICT_SECONDS of the current block. */
export function ruledRecently(read: Pick<SellerRead, 'verdictBlocks' | 'currentBlock' | 'blockSeconds'>): boolean {
  return read.verdictBlocks.some((block) => (read.currentBlock - block) * BigInt(read.blockSeconds) < VERDICT_SECONDS)
}

export function decideDelivery(read: SellerRead): DeliveryCheck {
  // A ruling comes first: a seller Arc ruled against is not paid, however recently it delivered.
  const age = (block: bigint) => (read.currentBlock - block) * BigInt(read.blockSeconds)
  if (ruledRecently(read)) return { kind: 'expired', line: RULED_AGAINST }
  if (read.sellerLive) return { kind: 'live', line: 'Delivered recently.' }
  // A payment under a minute old is not counted, because its seller entity may not be readable yet.
  const counted = read.paymentBlocks.filter((block) => age(block) > COUNT_AFTER_SECONDS)
  if (counted.length === 0) return { kind: 'first', line: 'First purchase from this seller.' }
  return { kind: 'expired', line: NOT_PAID }
}

/**
 * Reads one seller before it is paid. `payTo` is the address the listing says it is paid at, when
 * there is one: Arc's rulings are read by it as well as by vet402's own address for that name.
 */
export type SellerCheck = (seller: string, payTo?: string | null) => Promise<DeliveryCheck>

export function createSellerCheck(
  wire: Pick<ArkivWire, 'readSeller'>,
  log: (message: string) => void,
  scrub: (error: unknown) => string,
  payToOf: PayToOf = () => null,
): SellerCheck {
  return async (seller, payTo) => {
    try {
      return decideDelivery(await wire.readSeller({ name: seller, payTo: payToOf(seller), ...(payTo ? { rulingAddress: payTo } : {}) }))
    } catch (error) {
      // Fail closed: without the record, nothing is paid.
      log(`Arkiv seller read failed: ${scrub(error)}`)
      return { kind: 'expired', line: UNREADABLE }
    }
  }
}

/**
 * The check in front of vet402's own demo sellers (A to F). It looks at Arc's rulings only, read by the
 * address the seller is paid at, because a demo seller that never delivers is the point of its scene.
 * Returns the sentence the screen shows when the seller is not paid, or null when it may be.
 */
export function createRulingGate(
  wire: Pick<ArkivWire, 'readSeller'>,
  log: (message: string) => void,
  scrub: (error: unknown) => string,
  payToOf: PayToOf,
): (sellerName: string) => Promise<string | null> {
  return async (sellerName) => {
    const payTo = payToOf(sellerName)
    if (!payTo) return null
    try {
      return ruledRecently(await wire.readSeller({ name: sellerName, payTo })) ? `${sellerName}: ${RULED_AGAINST}` : null
    } catch (error) {
      // Fail closed, as the delivery check does.
      log(`Arkiv ruling read failed: ${scrub(error)}`)
      return `${sellerName}: ${UNREADABLE}`
    }
  }
}

/** Seller C alone uses SELLER_TTL_SECONDS. A lifetime has to be a whole number of blocks, so it rounds up. */
export function parseSellerTtl(value: string | undefined): number {
  const seconds = Number(value)
  if (!Number.isInteger(seconds) || seconds <= 0) return SELLER_SECONDS
  return Math.ceil(seconds / BLOCK_SECONDS) * BLOCK_SECONDS
}

const noResponseHash = (transferId: string) =>
  createHash('sha256').update(`no-response:${transferId}`).digest('hex')

const responseHashFor = (row: ReceiptRow, transferId: string) =>
  row.timesReceived > 0 ? row.responseHash : noResponseHash(transferId)

function receiptColumns(row: ReceiptRow, transferId: string, payTo: string | null) {
  return {
    job_id: row.id,
    seller: sellerColumn(row.sellerName),
    amount_micro: BigInt(row.amount),
    gateway_transfer_id: transferId,
    response_hash: responseHashFor(row, transferId),
    response_bytes: BigInt(row.responseBytes),
    times_received: BigInt(row.timesReceived),
    ...(payTo ? { pay_to: addressColumn(payTo) } : {}),
  }
}

/**
 * Whether this row may extend the seller's record. The answer has to have come back, and a sealed
 * answer has to have opened to the seller's promise. A sealed row only carries KEY_FROM_CHAIN when it
 * did, so an answer swapped after sealing never keeps its seller alive.
 */
export const keptPromise = (row: ReceiptRow): boolean =>
  row.timesReceived > 0 && (!row.sealed || (row.outcome ?? []).includes(KEY_FROM_CHAIN))

const receiptOptions = (): EntityOptions => ({
  expiration: ExpirationTime.fromDays(RECEIPT_DAYS),
  flags: { readonly: true, permissionlessExtension: true },
})

interface SinkOptions {
  wire: ArkivWire
  /** The local store. It is always written first, and it is what the app's own screen reads. */
  store: ReceiptStore
  sellerTtlSeconds: number
  log: (message: string) => void
  scrub: (error: unknown) => string
  /** Lets payment and seller entities carry the seller's payTo address. Without it they carry the name alone. */
  payToOf?: PayToOf
  /**
   * The buyer on the claim: the address that paid and filed it. Each evidence entity is handed to it,
   * so the record of the box is the buyer's. Absent, the evidence stays with the writer.
   */
  evidenceOwner?: Hex | null
  /** The writer's own address. An owner equal to it is not a hand over, so nothing is sent for it. */
  writer?: Hex
  /** When the box's postage batch ends, in Unix seconds, for a box vet402's own Bee node uploaded. */
  keptUntilOf?: (swarmRef: string) => number | null
  now?: () => number
}

/**
 * Puts Arkiv behind the local store. The local row is saved first and the Arkiv write follows in
 * one queue, so no write can hold up the screen or the payment, and a failed one only logs.
 * Everything a row has to write goes in one executeBatch transaction: the payment, the seller, the
 * evidence and, when Arc ruled on the same claim, the verdict. All of it lands or none of it does.
 */
export function createArkivSink({
  wire,
  store,
  sellerTtlSeconds,
  log,
  scrub,
  payToOf = () => null,
  evidenceOwner = null,
  writer,
  keptUntilOf = (ref) => swarmKeptUntil.get(ref) ?? null,
  now = Date.now,
}: SinkOptions) {
  const startedAt = now()
  const sellerKeys = new Map<string, Hex>()
  const failures = new Map<string, number>()
  const queued = new Set<string>()
  /** Rulings not yet on Arkiv, by claim id, with the number of failed tries. */
  const verdicts = new Map<string, { record: VerdictRecord; failures: number; queued: boolean }>()
  /** Evidence entities written but not yet handed to the buyer, by row id. */
  const handOvers = new Set<string>()
  let tail: Promise<void> = Promise.resolve()

  const owner =
    evidenceOwner && !isAddressEqual(evidenceOwner, zeroAddress) && !(writer && isAddressEqual(evidenceOwner, writer)) ? evidenceOwner : null

  const ttlFor = (seller: string) => (seller === SELLER_C_NAME ? sellerTtlSeconds : SELLER_SECONDS)
  const current = (id: string) => store.list().find((r) => r.id === id)

  /** Adds a line under the row's Details, once. It goes to the inner store, so it never queues another write. */
  function addDetail(id: string, line: string): void {
    const outcome = current(id)?.outcome ?? []
    if (!outcome.includes(detail(line))) store.update(id, { outcome: [...outcome, detail(line)] })
  }

  interface SellerPlan {
    id: SellerId
    cacheKey: string
    expiration: EntityOptions['expiration']
    known: Hex | null
    values: SellerValues
  }

  // The seller entity is extended, never patched. Its expiry is set to now plus the lifetime on each
  // delivery, and Arkiv refuses an extension that would end earlier.
  async function planSeller(row: ReceiptRow): Promise<SellerPlan> {
    const payTo = payToOf(row.sellerName)
    const id: SellerId = { name: row.sellerName, payTo }
    const cacheKey = payTo ? addressColumn(payTo) : sellerColumn(row.sellerName)
    return {
      id,
      cacheKey,
      expiration: ExpirationTime.fromSeconds(ttlFor(row.sellerName)),
      known: sellerKeys.get(cacheKey) ?? (await wire.findSellerKey(id)),
      values: { kind: 'seller', seller: sellerColumn(row.sellerName), ...(payTo ? { pay_to: addressColumn(payTo) } : {}) },
    }
  }

  const sellerWrite = (plan: SellerPlan): NonNullable<BatchWrite['seller']> =>
    plan.known
      ? { extend: plan.known, expiration: plan.expiration }
      : { create: { values: plan.values, options: { expiration: plan.expiration, flags: { readonly: true } } } }

  const verdictValues = (record: VerdictRecord): VerdictValues => ({
    kind: 'verdict',
    claim_id: record.claimId,
    seller: addressColumn(record.payTo),
    pay_to: addressColumn(record.payTo),
    verdict: record.verdict,
    ...(record.claimTx ? { claim_tx: record.claimTx } : {}),
    contract: addressColumn(record.contract),
    chain_id: BigInt(record.chainId),
  })

  /**
   * A wire without writeBatch (the tests' fakes) writes the same entities one by one, in the order the
   * batch lists them, and each key is kept as soon as it lands.
   */
  async function oneByOne(batch: BatchWrite, plan: SellerPlan | null, keep: (part: Partial<BatchResult>) => void): Promise<BatchResult> {
    const result: BatchResult = { handedOver: false }
    const put = (part: Partial<BatchResult>) => {
      Object.assign(result, part)
      keep(part)
    }
    if (batch.payment) put({ paymentKey: (await wire.createReceipt(batch.payment.values, batch.payment.options)).entityKey })
    if (batch.seller && plan) {
      if ('extend' in batch.seller) {
        try {
          await wire.extendEntity({ entityKey: batch.seller.extend, expiration: batch.seller.expiration })
          put({ sellerKey: batch.seller.extend })
        } catch (error) {
          sellerKeys.delete(plan.cacheKey)
          // Still readable means the extension itself failed. Gone means it expired, so it starts over.
          if (await wire.findSellerKey(plan.id)) throw error
          put({ sellerKey: (await wire.createSeller(plan.values, { expiration: plan.expiration, flags: { readonly: true } })).entityKey })
        }
      } else {
        put({ sellerKey: (await wire.createSeller(batch.seller.create.values, batch.seller.create.options)).entityKey })
      }
    }
    if (batch.settlement) put({ settlementKey: (await wire.createReceipt(batch.settlement.values, batch.settlement.options)).entityKey })
    if (batch.evidence) put({ evidenceKey: (await wire.createEvidence(batch.evidence.values, batch.evidence.options)).entityKey })
    if (batch.verdict) put({ verdictKey: (await wire.createVerdict(batch.verdict.values, batch.verdict.options)).entityKey })
    return result
  }

  /**
   * One transaction. When it fails for a reason the next try can fix, the batch goes again at once:
   * without the hand over, which then follows on its own, and with a new seller entity when the old one
   * has expired. Nothing goes again when something from the first try is readable, since then it landed.
   */
  async function sendBatch(
    batch: BatchWrite,
    plan: SellerPlan | null,
    landed: () => Promise<boolean>,
    keep: (part: Partial<BatchResult>) => void,
  ): Promise<BatchResult> {
    const writeBatch = wire.writeBatch
    if (!writeBatch) return oneByOne(batch, plan, keep)
    try {
      return await writeBatch(batch)
    } catch (error) {
      if (plan && batch.seller && 'extend' in batch.seller) sellerKeys.delete(plan.cacheKey)
      if (await landed()) throw error
      const again: BatchWrite = { ...batch }
      let changed = false
      if (again.evidenceOwner) {
        delete again.evidenceOwner
        changed = true
      }
      if (plan && batch.seller && 'extend' in batch.seller && !(await wire.findSellerKey(plan.id))) {
        again.seller = sellerWrite({ ...plan, known: null })
        changed = true
      }
      if (!changed) throw error
      log(`Arkiv batch failed, sending it again: ${scrub(error)}`)
      return await writeBatch(again)
    }
  }

  /** One batch for what the row still owes. Returns false when it owed nothing. */
  async function writeOnce(id: string): Promise<boolean> {
    const row = current(id)
    if (!row?.transferId || row.status === 'failed') return false
    const transferId = row.transferId
    const retry = failures.has(id)
    const payTo = payToOf(row.sellerName)
    const batch: BatchWrite = {}

    // A write that failed may still have landed. Look first, so a retry never makes a second entity.
    let paymentKey = (row.arkivPaymentKey as Hex | undefined) ?? (retry ? await wire.findPaymentKey(transferId) : null)
    if (paymentKey && !row.arkivPaymentKey) store.update(id, { arkivPaymentKey: paymentKey })
    if (!paymentKey) {
      batch.payment = { values: { kind: 'payment', ...receiptColumns(row, transferId, payTo), status: 'accepted' }, options: receiptOptions() }
    }

    // Only a delivery that kept its promise reaches the seller entity.
    const plan = keptPromise(row) && !row.arkivSellerDone ? await planSeller(row) : null
    if (plan) batch.seller = sellerWrite(plan)

    // A settlement names its payment entity, so it waits for the batch that wrote the payment.
    if (paymentKey && row.status === 'completed' && !row.arkivSettlementKey) {
      batch.settlement = {
        values: {
          kind: 'settlement',
          ...receiptColumns(row, transferId, payTo),
          status: 'settled',
          ...(row.batchTx ? { batch_tx: row.batchTx } : {}),
          payment_key: paymentKey,
        },
        options: receiptOptions(),
      }
    }

    // A new entity for the claim's box on Swarm. Nothing that exists is patched.
    const evidence = row.evidence
    let evidenceKey = (row.arkivEvidenceKey as Hex | undefined) ?? (evidence && retry ? await wire.findEvidenceKey(evidence.claimId) : null)
    if (evidenceKey && !row.arkivEvidenceKey) {
      store.update(id, { arkivEvidenceKey: evidenceKey })
      if (owner) handOvers.add(id)
    }
    if (evidence && !evidenceKey) {
      const keptUntil = keptUntilOf(evidence.swarmRef)
      batch.evidence = {
        values: {
          kind: 'evidence',
          claim_id: evidence.claimId,
          gateway_transfer_id: transferId,
          swarm_ref: evidence.swarmRef,
          ...(keptUntil ? { swarm_kept_until: BigInt(Math.floor(keptUntil)) } : {}),
        },
        options: receiptOptions(),
      }
      if (owner) batch.evidenceOwner = owner
    }

    // Arc's ruling on the same claim, when it is waiting, rides in the same transaction.
    const ruling = evidence ? [...verdicts.entries()].find(([claimId]) => claimId.toLowerCase() === evidence.claimId.toLowerCase()) : undefined
    if (ruling) {
      const [claimId, pending] = ruling
      if (pending.failures > 0 && (await wire.findVerdictKey(pending.record.claimId))) verdicts.delete(claimId)
      else batch.verdict = { values: verdictValues(pending.record), options: receiptOptions() }
    }

    const entities = entitiesIn(batch)
    if (entities === 0) return false

    const keep = (part: Partial<BatchResult>) => {
      if (part.paymentKey) {
        paymentKey = part.paymentKey
        store.update(id, { arkivPaymentKey: part.paymentKey })
      }
      if (part.sellerKey && plan) {
        sellerKeys.set(plan.cacheKey, part.sellerKey)
        store.update(id, { arkivSellerDone: true })
      }
      if (part.settlementKey) store.update(id, { arkivSettlementKey: part.settlementKey })
      if (part.evidenceKey) {
        evidenceKey = part.evidenceKey
        store.update(id, { arkivEvidenceKey: part.evidenceKey })
      }
      if (part.verdictKey && ruling) verdicts.delete(ruling[0])
    }
    const landed = async () =>
      batch.payment
        ? !!(await wire.findPaymentKey(transferId))
        : batch.evidence && evidence
          ? !!(await wire.findEvidenceKey(evidence.claimId))
          : batch.verdict && ruling
            ? !!(await wire.findVerdictKey(ruling[1].record.claimId))
            : false

    const result = await sendBatch(batch, plan, landed, keep)
    if (wire.writeBatch) {
      keep(result)
      if (entities > 1) addDetail(id, batchLine(entities))
    }
    if (batch.evidence && owner) {
      if (result.handedOver) addDetail(id, handedOverLine(owner))
      else handOvers.add(id)
    }
    return true
  }

  // An evidence entity that did not change owner in its own batch is handed over on its own.
  // One found after a failed try may already be the buyer's, so its owner is read first.
  async function handOver(id: string): Promise<void> {
    const key = current(id)?.arkivEvidenceKey as Hex | undefined
    if (!owner || !key || !wire.changeOwner || !handOvers.has(id)) return
    const now = wire.evidenceOwner ? await wire.evidenceOwner(key) : null
    if (!now || !isAddressEqual(now, owner)) await wire.changeOwner({ entityKey: key, newOwner: owner })
    handOvers.delete(id)
    addDetail(id, handedOverLine(owner))
  }

  async function step(id: string): Promise<void> {
    try {
      // A completed row that had no payment entity yet owes a second batch: the settlement names the payment.
      if (await writeOnce(id)) await writeOnce(id)
      await handOver(id)
      failures.delete(id)
    } catch (error) {
      failures.set(id, (failures.get(id) ?? 0) + 1)
      log(`Arkiv write failed: ${scrub(error)}`)
    }
  }

  function observe(id: string): void {
    if (queued.has(id)) return
    queued.add(id)
    tail = tail.then(async () => {
      queued.delete(id)
      await step(id)
    })
  }

  // A ruling with no row to ride with is a new entity on its own, from the same queue. A retry looks first, so a ruling is never written twice.
  async function verdictStep(claimId: string): Promise<void> {
    const pending = verdicts.get(claimId)
    if (!pending) return
    pending.queued = false
    const { record } = pending
    try {
      const found = pending.failures > 0 ? await wire.findVerdictKey(record.claimId) : null
      if (!found) {
        await wire.createVerdict(verdictValues(record), receiptOptions())
      }
      verdicts.delete(claimId)
    } catch (error) {
      pending.failures++
      log(`Arkiv verdict write failed: ${scrub(error)}`)
    }
  }

  function queueVerdict(claimId: string): void {
    const pending = verdicts.get(claimId)
    if (!pending || pending.queued) return
    pending.queued = true
    tail = tail.then(() => verdictStep(claimId))
  }

  const hasWork = (row: ReceiptRow) =>
    !!row.transferId &&
    row.status !== 'failed' &&
    (!row.arkivPaymentKey ||
      (keptPromise(row) && !row.arkivSellerDone) ||
      (row.status === 'completed' && !row.arkivSettlementKey) ||
      (!!row.evidence && !row.arkivEvidenceKey) ||
      handOvers.has(row.id))

  return {
    store: {
      list: () => store.list(),
      add(row) {
        store.add(row)
        observe(row.id)
      },
      update(id, patch) {
        store.update(id, patch)
        observe(id)
      },
    } satisfies ReceiptStore,

    /** Writes Arc's ruling on one claim to Arkiv. Never throws, and never holds up the caller. */
    recordVerdict(record: VerdictRecord): void {
      if (!verdicts.has(record.claimId)) verdicts.set(record.claimId, { record, failures: 0, queued: false })
      queueVerdict(record.claimId)
    },

    /** Retries what is unfinished. Rows from before this run are left alone unless they already have a payment entity. */
    sweep(): void {
      for (const row of store.list().slice(0, SWEEP_ROWS)) {
        const ownRun = Date.parse(row.at) >= startedAt || !!row.arkivPaymentKey
        if (ownRun && hasWork(row) && (failures.get(row.id) ?? 0) < MAX_ATTEMPTS) observe(row.id)
      }
      for (const [claimId, pending] of verdicts) if (pending.failures < MAX_ATTEMPTS) queueVerdict(claimId)
    },

    /** Resolves when every queued write has been tried. */
    idle: () => tail,
  }
}
