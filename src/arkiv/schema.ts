import { defineSchema, str, u64 } from '@arkiv-network/sdk/schema'

/** Shared by payment and settlement entities, so one query returns both for a transfer id. */
export const ReceiptSchema = defineSchema('vet402_receipt', {
  kind: str().indexed(),
  job_id: str().indexed(),
  seller: str().indexed(),
  amount_micro: u64(),
  gateway_transfer_id: str().indexed(),
  response_hash: str(),
  response_bytes: u64(),
  times_received: u64(),
  status: str().indexed(),
  batch_tx: str().optional(),
  payment_key: str().indexed().optional(),
})

export const SellerSchema = defineSchema('vet402_seller', {
  kind: str().indexed(),
  seller: str().indexed(),
})

/** Points one claim at its box on Swarm. The reference is unencrypted, and the box inside holds no key. */
export const EvidenceSchema = defineSchema('vet402_evidence', {
  kind: str().indexed(),
  claim_id: str().indexed(),
  gateway_transfer_id: str().indexed(),
  swarm_ref: str(),
})

/** Rows the live check writes. The receipts screen leaves them out. */
export const LIVE_CHECK_PREFIX = 'live-check-'

/** A str column holds at most 128 bytes. Seller names come from a public catalog, so they are cut to fit. */
export function sellerColumn(name: string): string {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length <= 128) return name
  return new TextDecoder().decode(bytes.slice(0, 128)).replace(/�+$/, '')
}
