import { createPublicClient } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { asc, eq, or } from '@arkiv-network/sdk/query'
import { http } from 'viem'
import type { Hex, Transport } from 'viem'
import { rulingOnArc } from '../../packages/sealed-delivery/src/rulings'
import type { ArcCheckOptions, ArcRuling } from '../../packages/sealed-delivery/src/rulings'
import { latestRuling } from './sellerCheck'
import type { RawRuling, RulingsRead } from './sellerCheck'
import type { RawRead } from './receiptsFeed'
import { PAGE_SIZE, readAllPages } from './pages'
import { addressColumn, EvidenceSchema, ReceiptSchema, SellerSchema, VerdictSchema } from './schema'

const RECEIPT_FIELDS = {
  $key: true,
  $expiresAt: true,
  kind: true,
  seller: true,
  amount_micro: true,
  gateway_transfer_id: true,
  response_hash: true,
  response_bytes: true,
  times_received: true,
  batch_tx: true,
  payment_key: true,
  pay_to: true,
} as const

/** The address a ruling is against: `pay_to` when the entity has it, `seller` on entities written before it. */
const verdictAddress = (row: { seller: { value: string }; pay_to?: { value: string } }) => row.pay_to?.value ?? row.seller.value

/**
 * Reads the public endpoint with the writer filter. No key is involved. Payments and settlements are
 * separate queries on the indexed `kind`, and each one is read to its last page.
 */
export function createArkivReader(writer: Hex, transport: Transport = http(undefined, { retryCount: 0 })) {
  const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport })

  const receipts = (kind: 'payment' | 'settlement') =>
    readAllPages((offset) =>
      client
        .select(RECEIPT_FIELDS)
        .from(ReceiptSchema)
        .where(eq('kind', kind))
        .ownedBy(writer)
        .orderBy(asc('$key'))
        .limit(PAGE_SIZE)
        .offset(offset)
        .fetch(),
    )

  return async function read(): Promise<RawRead> {
    const [payments, settlements, sellers, verdicts, timing] = await Promise.all([
      receipts('payment'),
      receipts('settlement'),
      readAllPages((offset) =>
        client
          .select({ $key: true, $expiresAt: true, seller: true, pay_to: true })
          .from(SellerSchema)
          .where(eq('kind', 'seller'))
          .ownedBy(writer)
          .orderBy(asc('$key'))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch(),
      ),
      readAllPages((offset) =>
        client
          .select({ $key: true, $createdAt: true, seller: true, pay_to: true, verdict: true })
          .from(VerdictSchema)
          .where(eq('kind', 'verdict'))
          .ownedBy(writer)
          .orderBy(asc('$key'))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch(),
      ),
      client.getBlockTiming(),
    ])

    return {
      receipts: [...payments, ...settlements].map((row) => ({
        key: row.$key,
        expiresAt: row.$expiresAt ?? 0n,
        kind: row.kind.value,
        seller: row.seller.value,
        amountMicro: row.amount_micro.value,
        transferId: row.gateway_transfer_id.value,
        responseHash: row.response_hash.value,
        responseBytes: row.response_bytes.value,
        timesReceived: row.times_received.value,
        batchTx: row.batch_tx?.value ?? null,
        paymentKey: row.payment_key?.value ?? null,
        payTo: row.pay_to?.value ?? null,
      })),
      sellers: sellers.map((row) => ({
        seller: row.seller.value,
        payTo: row.pay_to?.value ?? null,
        expiresAt: row.$expiresAt ?? 0n,
      })),
      verdicts: verdicts.map((row) => ({
        seller: verdictAddress(row),
        verdict: row.verdict.value,
        createdAt: row.$createdAt ?? 0n,
      })),
      timing,
    }
  }
}

/** Counts the entities of the receipt schema for these transfer ids: a payment and, once settled, its settlement. */
export function createArkivCounter(writer: Hex, transport: Transport = http(undefined, { retryCount: 0 })) {
  const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport })

  return async function count(transferIds: string[]): Promise<number> {
    const pages = await Promise.all(
      transferIds.map((id) =>
        client
          .select({ $key: true })
          .from(ReceiptSchema)
          .where(eq('gateway_transfer_id', id))
          .ownedBy(writer)
          .limit(100)
          .fetch(),
      ),
    )
    return new Set(pages.flatMap((page) => page.entities.map((row) => row.$key))).size
  }
}

/**
 * The Swarm reference this writer recorded for one claim, or null when it recorded none. Read by
 * creator: the entity belongs to the buyer once vet402 hands it over, and only vet402 can be its creator.
 */
export function createEvidenceReader(writer: Hex, transport: Transport = http(undefined, { retryCount: 0, timeout: 8000 })) {
  const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport })

  return async function readEvidence(claimId: string): Promise<string | null> {
    const { entities } = await client
      .select({ $key: true, swarm_ref: true })
      .from(EvidenceSchema)
      .where(eq('kind', 'evidence'))
      .where(eq('claim_id', claimId))
      .createdBy(writer)
      .limit(1)
      .fetch()
    return entities[0]?.swarm_ref.value ?? null
  }
}

/**
 * Every `vet402_evidence` entity this writer created: each claim, the Swarm reference of its box, the
 * date its postage batch keeps it until when vet402's own Bee node stamped it, and who owns the entity now.
 */
export function createEvidenceLister(writer: Hex, transport: Transport = http(undefined, { retryCount: 0, timeout: 8000 })) {
  const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport })

  return async function listEvidence(): Promise<{ claimId: string; swarmRef: string; keptUntil?: number; owner?: string }[]> {
    const rows = await readAllPages((offset) =>
      client
        .select({ $key: true, $owner: true, claim_id: true, swarm_ref: true, swarm_kept_until: true })
        .from(EvidenceSchema)
        .where(eq('kind', 'evidence'))
        .createdBy(writer)
        .orderBy(asc('$key'))
        .limit(PAGE_SIZE)
        .offset(offset)
        .fetch(),
    )
    return rows.map((row) => {
      const keptUntil = row.swarm_kept_until?.value
      return {
        claimId: row.claim_id.value,
        swarmRef: row.swarm_ref.value,
        ...(keptUntil ? { keptUntil: Number(keptUntil) } : {}),
        ...(row.$owner ? { owner: row.$owner } : {}),
      }
    })
  }
}

/**
 * Every ruling this writer recorded against one payTo address, with the block timing to date them.
 * The filter matches either address column, and a row is kept only when its own address is the one
 * asked for, so an entity with `pay_to` is judged by `pay_to`. No key and no backend are involved.
 * The latest ruling is then looked up on Arc. A failed Arc read only leaves out the line it would give.
 *
 * With `writers` set to 'any', every writer's rulings are read, and a ruling is kept only once Arc holds
 * its event. `writer` is then vet402's own address, which names vet402 in the answer and alone sets the
 * date vet402 pays again. Without an Arc check there is nothing to keep, so 'any' needs `arc`.
 */
export function createRulingsReader(
  writer: Hex,
  transport: Transport = http(undefined, { retryCount: 0, timeout: 8000 }),
  arc: ArcCheckOptions | null = {},
  writers: 'own' | 'any' = 'own',
) {
  const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport })

  if (writers === 'any') {
    if (!arc) throw new Error("writers 'any' keeps only rulings Arc confirms, so it needs the Arc check")
    return (payTo: string) => readAnyWriter(payTo, arc)
  }

  return async function readRulings(payTo: string): Promise<RulingsRead> {
    const read = await readRows(payTo)
    const latest = latestRuling(read.rulings)
    if (!arc || !latest?.key || !latest.claimTx) return read
    const writtenAt = read.timing.currentBlockTime - Number((read.timing.currentBlock - latest.createdAt) * BigInt(read.timing.blockDuration))
    const onArc = await onArcFor(payTo, latest.key, { ...latest, writtenAt }, arc).catch(() => false)
    return onArc ? { ...read, rulings: read.rulings.map((r) => (r === latest ? { ...r, onArc: true } : r)) } : read
  }

  // The contract and chain are read for the latest ruling alone, so a list read never drops an entity that lacks them.
  async function onArcFor(payTo: string, key: Hex, ruling: Omit<ArcRuling, 'contract' | 'chainId'>, options: ArcCheckOptions) {
    const { $attributes } = await client.getEntity(key)
    const value = (name: string) => {
      const found = ($attributes as Record<string, { value?: unknown } | undefined> | undefined)?.[name]?.value
      // Arkiv attributes are strings or numbers. Anything else has no address or chain in it.
      if (typeof found === 'string') return found
      if (typeof found === 'number' || typeof found === 'bigint' || typeof found === 'boolean') return String(found)
      return null
    }
    return rulingOnArc(payTo, { ...ruling, contract: value('contract'), chainId: value('chain_id') }, options)
  }

  // Newest first. The newest confirmed ruling decides the answer, and vet402's newest confirmed one sets
  // the date it pays again, so the Arc reads stop once both are found. When Arc confirms none and a read
  // of it failed, the whole read fails, so a node that is down never reads as a clear seller.
  async function readAnyWriter(payTo: string, arc: ArcCheckOptions): Promise<RulingsRead> {
    const address = addressColumn(payTo)
    const own = writer.toLowerCase()
    const [rows, timing] = await Promise.all([
      readAllPages((offset) =>
        client
          .select({
            $key: true,
            $createdAt: true,
            $creator: true,
            claim_id: true,
            claim_tx: true,
            seller: true,
            pay_to: true,
            verdict: true,
            contract: true,
            chain_id: true,
          })
          .from(VerdictSchema)
          .where(eq('kind', 'verdict'))
          .where(or(eq('pay_to', address), eq('seller', address)))
          .orderBy(asc('$key'))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch(),
      ),
      client.getBlockTiming(),
    ])
    const newestFirst = rows
      .filter((row) => verdictAddress(row) === address)
      .sort((a, b) => ((b.$createdAt ?? 0n) > (a.$createdAt ?? 0n) ? 1 : (b.$createdAt ?? 0n) < (a.$createdAt ?? 0n) ? -1 : 0))
    const kept: RawRuling[] = []
    let failed: unknown = null
    for (const row of newestFirst) {
      const by = row.$creator?.toLowerCase()
      const haveAny = kept.length > 0
      const haveOwn = kept.some((r) => r.writer === own)
      if (haveAny && haveOwn) break
      if (haveAny && by !== own) continue
      const createdAt = row.$createdAt ?? 0n
      const writtenAt = timing.currentBlockTime - Number((timing.currentBlock - createdAt) * BigInt(timing.blockDuration))
      const ruling = {
        claimId: row.claim_id.value,
        claimTx: row.claim_tx?.value ?? null,
        contract: row.contract.value,
        chainId: row.chain_id.value,
        verdict: row.verdict.value,
        writtenAt,
      }
      const confirmed = await rulingOnArc(payTo, ruling, arc).catch((error: unknown) => {
        failed = error
        return false
      })
      if (!confirmed) continue
      kept.push({
        verdict: ruling.verdict,
        claimId: ruling.claimId,
        claimTx: ruling.claimTx,
        key: row.$key,
        createdAt,
        onArc: true,
        ...(by ? { writer: by } : {}),
      })
    }
    if (kept.length === 0 && failed) throw failed instanceof Error ? failed : new Error('The Arc read for a ruling failed')
    return { rulings: kept, timing, own }
  }

  async function readRows(payTo: string): Promise<RulingsRead> {
    const address = addressColumn(payTo)
    const [rows, timing] = await Promise.all([
      readAllPages((offset) =>
        client
          .select({ $key: true, $createdAt: true, claim_id: true, claim_tx: true, seller: true, pay_to: true, verdict: true })
          .from(VerdictSchema)
          .where(eq('kind', 'verdict'))
          .where(or(eq('pay_to', address), eq('seller', address)))
          .ownedBy(writer)
          .orderBy(asc('$key'))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch(),
      ),
      client.getBlockTiming(),
    ])
    return {
      rulings: rows
        .filter((row) => verdictAddress(row) === address)
        .map((row) => ({
          verdict: row.verdict.value,
          claimId: row.claim_id.value,
          claimTx: row.claim_tx?.value ?? null,
          key: row.$key,
          createdAt: row.$createdAt ?? 0n,
        })),
      timing,
    }
  }
}
