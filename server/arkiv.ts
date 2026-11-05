import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { eq } from '@arkiv-network/sdk/query'
import { u64 } from '@arkiv-network/sdk/schema'
import { http } from 'viem'
import type { Hex, Transport } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ReceiptSchema, sellerColumn, SellerSchema } from '../src/arkiv/schema'
import type { ReceiptRow, ReceiptStore } from './receiptStore'
import { SELLER_C_NAME } from './sellers'

export const RECEIPT_DAYS = 30
export const SELLER_SECONDS = 604800
export const COUNT_AFTER_SECONDS = 60n

const READ_TIMEOUT_MS = 5000
const MAX_ATTEMPTS = 5
const SWEEP_ROWS = 20
const BLOCK_SECONDS = 2

export const NOT_PAID = 'No recent delivery from this seller. Not paid.'

export type DeliveryCheck =
  | { kind: 'live'; line: 'Delivered recently.' }
  | { kind: 'first'; line: 'First purchase from this seller.' }
  | { kind: 'expired'; line: typeof NOT_PAID }
  | { kind: 'busy'; line: 'Arkiv is busy. Buying without the delivery check.' }

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
}

export interface SellerValues {
  kind: 'seller'
  seller: string
}

export interface EntityOptions {
  expiration: ReturnType<typeof ExpirationTime.fromSeconds>
  flags: { readonly: true; permissionlessExtension?: true }
}

export interface SellerRead {
  sellerLive: boolean
  /** The block each payment entity was created in. */
  paymentBlocks: bigint[]
  currentBlock: bigint
  blockSeconds: number
}

/** Everything that touches Arkiv. Tests swap this out, so they never reach the network. */
export interface ArkivWire {
  createReceipt(values: ReceiptValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  createSeller(values: SellerValues, options: EntityOptions): Promise<{ entityKey: Hex }>
  extendEntity(params: { entityKey: Hex; expiration: EntityOptions['expiration'] }): Promise<{ expiresAt: bigint }>
  findPaymentKey(transferId: string): Promise<Hex | null>
  findSellerKey(seller: string): Promise<Hex | null>
  readSeller(seller: string): Promise<SellerRead>
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

      async findSellerKey(seller) {
        const { entities } = await reads
          .select({ $key: true })
          .from(SellerSchema)
          .where(eq('kind', 'seller'))
          .where(eq('seller', sellerColumn(seller)))
          .ownedBy(writer)
          .limit(1)
          .fetch()
        return entities[0]?.$key ?? null
      },

      async readSeller(seller) {
        const name = sellerColumn(seller)
        const [live, payments, timing] = await Promise.all([
          reads
            .select({ $key: true })
            .from(SellerSchema)
            .where(eq('kind', 'seller'))
            .where(eq('seller', name))
            .ownedBy(writer)
            .limit(1)
            .fetch(),
          reads
            .select({ $key: true, $createdAt: true })
            .from(ReceiptSchema)
            .where(eq('kind', 'payment'))
            .where(eq('seller', name))
            .ownedBy(writer)
            .limit(100)
            .fetch(),
          reads.getBlockTiming(),
        ])
        return {
          sellerLive: live.entities.length > 0,
          paymentBlocks: payments.entities.flatMap((row) => (row.$createdAt === undefined ? [] : [row.$createdAt])),
          currentBlock: timing.currentBlock,
          blockSeconds: timing.blockDuration,
        }
      },
    },
  }
}

/** What the screen may do about this seller, given what Arkiv holds for it. */
export function decideDelivery(read: SellerRead): DeliveryCheck {
  if (read.sellerLive) return { kind: 'live', line: 'Delivered recently.' }
  // A payment under a minute old is not counted, because its seller entity may not be readable yet.
  const counted = read.paymentBlocks.filter(
    (block) => (read.currentBlock - block) * BigInt(read.blockSeconds) > COUNT_AFTER_SECONDS,
  )
  if (counted.length === 0) return { kind: 'first', line: 'First purchase from this seller.' }
  return { kind: 'expired', line: NOT_PAID }
}

export type SellerCheck = (seller: string) => Promise<DeliveryCheck>

export function createSellerCheck(
  wire: Pick<ArkivWire, 'readSeller'>,
  log: (message: string) => void,
  scrub: (error: unknown) => string,
): SellerCheck {
  return async (seller) => {
    try {
      return decideDelivery(await wire.readSeller(seller))
    } catch (error) {
      log(`Arkiv seller read failed: ${scrub(error)}`)
      return { kind: 'busy', line: 'Arkiv is busy. Buying without the delivery check.' }
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

function receiptColumns(row: ReceiptRow, transferId: string) {
  return {
    job_id: row.id,
    seller: sellerColumn(row.sellerName),
    amount_micro: BigInt(row.amount),
    gateway_transfer_id: transferId,
    response_hash: responseHashFor(row, transferId),
    response_bytes: BigInt(row.responseBytes),
    times_received: BigInt(row.timesReceived),
  }
}

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
  now?: () => number
}

/**
 * Puts Arkiv behind the local store. The local row is saved first and the Arkiv write follows in
 * one queue, so no write can hold up the screen or the payment, and a failed one only logs.
 */
export function createArkivSink({ wire, store, sellerTtlSeconds, log, scrub, now = Date.now }: SinkOptions) {
  const startedAt = now()
  const sellerKeys = new Map<string, Hex>()
  const failures = new Map<string, number>()
  const queued = new Set<string>()
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
          { kind: 'payment', ...receiptColumns(row, transferId), status: 'accepted' },
          receiptOptions(),
        )
      ).entityKey
    store.update(row.id, { arkivPaymentKey: entityKey })
    return entityKey
  }

  // Only a real delivery gets here. The seller entity is extended, never patched.
  async function ensureSeller(row: ReceiptRow): Promise<void> {
    const seller = sellerColumn(row.sellerName)
    const expiration = ExpirationTime.fromSeconds(ttlFor(row.sellerName))
    const known = sellerKeys.get(seller) ?? (await wire.findSellerKey(seller))
    if (known) {
      try {
        await wire.extendEntity({ entityKey: known, expiration })
        sellerKeys.set(seller, known)
        store.update(row.id, { arkivSellerDone: true })
        return
      } catch (error) {
        sellerKeys.delete(seller)
        // Still readable means the extension itself failed. Gone means it expired, so it starts over.
        if (await wire.findSellerKey(seller)) throw error
      }
    }
    const { entityKey } = await wire.createSeller({ kind: 'seller', seller }, { expiration, flags: { readonly: true } })
    sellerKeys.set(seller, entityKey)
    store.update(row.id, { arkivSellerDone: true })
  }

  async function ensureSettlement(row: ReceiptRow, transferId: string, paymentKey: Hex): Promise<void> {
    const { entityKey } = await wire.createReceipt(
      {
        kind: 'settlement',
        ...receiptColumns(row, transferId),
        status: 'settled',
        ...(row.batchTx ? { batch_tx: row.batchTx } : {}),
        payment_key: paymentKey,
      },
      receiptOptions(),
    )
    store.update(row.id, { arkivSettlementKey: entityKey })
  }

  async function step(id: string): Promise<void> {
    const row = store.list().find((r) => r.id === id)
    // Gateway has to report the payment before it can be written.
    if (!row?.transferId || row.status === 'failed') return
    try {
      const paymentKey = await ensurePayment(row, row.transferId)
      if (row.timesReceived > 0 && !row.arkivSellerDone) await ensureSeller(row)
      if (row.status === 'completed' && !row.arkivSettlementKey) await ensureSettlement(row, row.transferId, paymentKey)
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

  const hasWork = (row: ReceiptRow) =>
    !!row.transferId &&
    row.status !== 'failed' &&
    (!row.arkivPaymentKey ||
      (row.timesReceived > 0 && !row.arkivSellerDone) ||
      (row.status === 'completed' && !row.arkivSettlementKey))

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

    /** Retries what is unfinished. Rows from before this run are left alone unless they already have a payment entity. */
    sweep(): void {
      for (const row of store.list().slice(0, SWEEP_ROWS)) {
        const ownRun = Date.parse(row.at) >= startedAt || !!row.arkivPaymentKey
        if (ownRun && hasWork(row) && (failures.get(row.id) ?? 0) < MAX_ATTEMPTS) observe(row.id)
      }
    },

    /** Resolves when every queued write has been tried. */
    idle: () => tail,
  }
}
