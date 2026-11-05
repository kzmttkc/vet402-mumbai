import { createPublicClient } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { eq } from '@arkiv-network/sdk/query'
import { http } from 'viem'
import type { Hex, Transport } from 'viem'
import type { RawRead } from './receiptsFeed'
import { EvidenceSchema, ReceiptSchema, SellerSchema } from './schema'

/** Reads the public endpoint with the writer filter. No key is involved. */
export function createArkivReader(writer: Hex, transport: Transport = http(undefined, { retryCount: 0 })) {
  const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport })

  return async function read(): Promise<RawRead> {
    const [receipts, sellers, timing] = await Promise.all([
      client
        .select({
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
        })
        .from(ReceiptSchema)
        .ownedBy(writer)
        .limit(100)
        .fetch(),
      client.select({ $key: true, $expiresAt: true, seller: true }).from(SellerSchema).ownedBy(writer).limit(100).fetch(),
      client.getBlockTiming(),
    ])

    return {
      receipts: receipts.entities.map((row) => ({
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
      })),
      sellers: sellers.entities.map((row) => ({ seller: row.seller.value, expiresAt: row.$expiresAt ?? 0n })),
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

/** The Swarm reference this writer recorded for one claim, or null when it recorded none. */
export function createEvidenceReader(writer: Hex, transport: Transport = http(undefined, { retryCount: 0, timeout: 8000 })) {
  const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport })

  return async function readEvidence(claimId: string): Promise<string | null> {
    const { entities } = await client
      .select({ $key: true, swarm_ref: true })
      .from(EvidenceSchema)
      .where(eq('kind', 'evidence'))
      .where(eq('claim_id', claimId))
      .ownedBy(writer)
      .limit(1)
      .fetch()
    return entities[0]?.swarm_ref.value ?? null
  }
}
