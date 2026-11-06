import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { asc, eq } from '@arkiv-network/sdk/query'
import { u64 } from '@arkiv-network/sdk/schema'
import { http } from 'viem'
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
  /** The payTo address, lowercase. */
  seller: string
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
  payTo: string | null
}

/** The payTo address vet402 knows for a seller name, or null. Only vet402's own configuration answers it. */
export type PayToOf = (sellerName: string) => string | null

export interface EvidenceValues {
  kind: 'evidence'
  claim_id: string
  gateway_transfer_id: string
  swarm_ref: string
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

/** Everything that touches Arkiv. Tests swap this out, so they never reach the network. */
export interface ArkivWire {
  createReceipt(values: ReceiptValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  createSeller(values: SellerValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  createEvidence(values: EvidenceValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  createVerdict(values: VerdictValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  /** Sets a new expiry. A duration counts from now, it is not added to what is left. */
  extendEntity(params: { entityKey: Hex; expiration: EntityOptions['expiration'] }): Promise<{ expiresAt: bigint }>
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

export function createArkivWire({ writerKey, accessKey, transport }: WireEnv): { wire: ArkivWire; writer: Hex } {
  const chain = rabdi({ accessKey })
  const account = privateKeyToAccount(writerKey)
  const writer = account.address
  const reads = createPublicClient({
    chain,
    transport: transport ?? http(undefined, { retryCount: 0, timeout: READ_TIMEOUT_MS }),
  })
  // No nonceManager, on purpose: one queue sends one write at a time.
  const writes = createWalletClient({ chain, transport: transport ?? http(), account })

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
    writer,
    wire: {
      createReceipt: (values, options) =>
        writes.createEntity(
          ReceiptSchema,
          {
            ...values,
            amount_micro: u64(values.amount_micro),
            response_bytes: u64(values.response_bytes),
            times_received: u64(values.times_received),
          },
          options,
        ),
      createSeller: (values, options) => writes.createEntity(SellerSchema, values, options),
      createEvidence: (values, options) => writes.createEntity(EvidenceSchema, values, options),
      createVerdict: (values, options) =>
        writes.createEntity(VerdictSchema, { ...values, chain_id: u64(values.chain_id) }, options),
      extendEntity: (params) => writes.extendEntity(params),

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

      async findEvidenceKey(claimId) {
        const { entities } = await reads
          .select({ $key: true })
          .from(EvidenceSchema)
          .where(eq('kind', 'evidence'))
          .where(eq('claim_id', claimId))
          .ownedBy(writer)
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
          seller.payTo ? readVerdicts(seller.payTo) : Promise.resolve([]),
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
    },
  }
}

/** What the screen may do about this seller, given what Arkiv holds for it. */
export function decideDelivery(read: SellerRead): DeliveryCheck {
  // A ruling comes first: a seller Arc ruled against is not paid, however recently it delivered.
  const age = (block: bigint) => (read.currentBlock - block) * BigInt(read.blockSeconds)
  if (read.verdictBlocks.some((block) => age(block) < VERDICT_SECONDS)) return { kind: 'expired', line: RULED_AGAINST }
  if (read.sellerLive) return { kind: 'live', line: 'Delivered recently.' }
  // A payment under a minute old is not counted, because its seller entity may not be readable yet.
  const counted = read.paymentBlocks.filter((block) => age(block) > COUNT_AFTER_SECONDS)
  if (counted.length === 0) return { kind: 'first', line: 'First purchase from this seller.' }
  return { kind: 'expired', line: NOT_PAID }
}

export type SellerCheck = (seller: string) => Promise<DeliveryCheck>

export function createSellerCheck(
  wire: Pick<ArkivWire, 'readSeller'>,
  log: (message: string) => void,
  scrub: (error: unknown) => string,
  payToOf: PayToOf = () => null,
): SellerCheck {
  return async (seller) => {
    try {
      return decideDelivery(await wire.readSeller({ name: seller, payTo: payToOf(seller) }))
    } catch (error) {
      // Fail closed: without the record, nothing is paid.
      log(`Arkiv seller read failed: ${scrub(error)}`)
      return { kind: 'expired', line: UNREADABLE }
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
  now?: () => number
}

/**
 * Puts Arkiv behind the local store. The local row is saved first and the Arkiv write follows in
 * one queue, so no write can hold up the screen or the payment, and a failed one only logs.
 */
export function createArkivSink({ wire, store, sellerTtlSeconds, log, scrub, payToOf = () => null, now = Date.now }: SinkOptions) {
  const startedAt = now()
  const sellerKeys = new Map<string, Hex>()
  const failures = new Map<string, number>()
  const queued = new Set<string>()
  /** Rulings not yet on Arkiv, by claim id, with the number of failed tries. */
  const verdicts = new Map<string, { record: VerdictRecord; failures: number; queued: boolean }>()
  let tail: Promise<void> = Promise.resolve()

  const ttlFor = (seller: string) => (seller === SELLER_C_NAME ? sellerTtlSeconds : SELLER_SECONDS)

  async function ensurePayment(row: ReceiptRow, transferId: string): Promise<Hex> {
    if (row.arkivPaymentKey) return row.arkivPaymentKey as Hex
    // A write that failed may still have landed. Look first, so a retry never makes a second payment entity.
    const found = failures.has(row.id) ? await wire.findPaymentKey(transferId) : null
    const entityKey =
      found ??
      (
        await wire.createReceipt(
          { kind: 'payment', ...receiptColumns(row, transferId, payToOf(row.sellerName)), status: 'accepted' },
          receiptOptions(),
        )
      ).entityKey
    store.update(row.id, { arkivPaymentKey: entityKey })
    return entityKey
  }

  // Only a delivery that kept its promise gets here. The seller entity is extended, never patched.
  // The expiry is set to now plus the lifetime on each delivery. Arkiv refuses an extension that would end earlier.
  async function ensureSeller(row: ReceiptRow): Promise<void> {
    const payTo = payToOf(row.sellerName)
    const id: SellerId = { name: row.sellerName, payTo }
    const cacheKey = payTo ? addressColumn(payTo) : sellerColumn(row.sellerName)
    const expiration = ExpirationTime.fromSeconds(ttlFor(row.sellerName))
    const known = sellerKeys.get(cacheKey) ?? (await wire.findSellerKey(id))
    if (known) {
      try {
        await wire.extendEntity({ entityKey: known, expiration })
        sellerKeys.set(cacheKey, known)
        store.update(row.id, { arkivSellerDone: true })
        return
      } catch (error) {
        sellerKeys.delete(cacheKey)
        // Still readable means the extension itself failed. Gone means it expired, so it starts over.
        if (await wire.findSellerKey(id)) throw error
      }
    }
    const { entityKey } = await wire.createSeller(
      { kind: 'seller', seller: sellerColumn(row.sellerName), ...(payTo ? { pay_to: addressColumn(payTo) } : {}) },
      { expiration, flags: { readonly: true } },
    )
    sellerKeys.set(cacheKey, entityKey)
    store.update(row.id, { arkivSellerDone: true })
  }

  async function ensureSettlement(row: ReceiptRow, transferId: string, paymentKey: Hex): Promise<void> {
    const { entityKey } = await wire.createReceipt(
      {
        kind: 'settlement',
        ...receiptColumns(row, transferId, payToOf(row.sellerName)),
        status: 'settled',
        ...(row.batchTx ? { batch_tx: row.batchTx } : {}),
        payment_key: paymentKey,
      },
      receiptOptions(),
    )
    store.update(row.id, { arkivSettlementKey: entityKey })
  }

  // A new entity for the claim's box on Swarm. Nothing that exists is patched.
  async function ensureEvidence(row: ReceiptRow, transferId: string): Promise<void> {
    const evidence = row.evidence
    if (!evidence || row.arkivEvidenceKey) return
    const found = failures.has(row.id) ? await wire.findEvidenceKey(evidence.claimId) : null
    const entityKey =
      found ??
      (
        await wire.createEvidence(
          { kind: 'evidence', claim_id: evidence.claimId, gateway_transfer_id: transferId, swarm_ref: evidence.swarmRef },
          receiptOptions(),
        )
      ).entityKey
    store.update(row.id, { arkivEvidenceKey: entityKey })
  }

  async function step(id: string): Promise<void> {
    const row = store.list().find((r) => r.id === id)
    // Gateway has to report the payment before it can be written.
    if (!row?.transferId || row.status === 'failed') return
    try {
      const paymentKey = await ensurePayment(row, row.transferId)
      if (keptPromise(row) && !row.arkivSellerDone) await ensureSeller(row)
      if (row.status === 'completed' && !row.arkivSettlementKey) await ensureSettlement(row, row.transferId, paymentKey)
      await ensureEvidence(row, row.transferId)
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

  // A new entity per ruling, from the same queue. A retry looks first, so a ruling is never written twice.
  async function verdictStep(claimId: string): Promise<void> {
    const pending = verdicts.get(claimId)
    if (!pending) return
    pending.queued = false
    const { record } = pending
    try {
      const found = pending.failures > 0 ? await wire.findVerdictKey(record.claimId) : null
      if (!found) {
        await wire.createVerdict(
          {
            kind: 'verdict',
            claim_id: record.claimId,
            seller: addressColumn(record.payTo),
            verdict: record.verdict,
            ...(record.claimTx ? { claim_tx: record.claimTx } : {}),
            contract: addressColumn(record.contract),
            chain_id: BigInt(record.chainId),
          },
          receiptOptions(),
        )
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
      (!!row.evidence && !row.arkivEvidenceKey))

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
