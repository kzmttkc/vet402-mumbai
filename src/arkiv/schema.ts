import { defineSchema, str, u64 } from '@arkiv-network/sdk/schema'

/**
 * Shared by payment and settlement entities, so one query returns both for a transfer id. Only the
 * columns some query filters on are indexed: kind, seller, gateway_transfer_id and pay_to.
 */
export const ReceiptSchema = defineSchema('vet402_receipt', {
  kind: str().indexed(),
  job_id: str(),
  seller: str().indexed(),
  amount_micro: u64(),
  gateway_transfer_id: str().indexed(),
  response_hash: str(),
  response_bytes: u64(),
  times_received: u64(),
  status: str(),
  batch_tx: str().optional(),
  payment_key: str().optional(),
  /** The address the seller is paid at, lowercase. Absent on entities written before it existed. */
  pay_to: str().indexed().optional(),
})

/** One per seller. Found by pay_to when vet402 knows the address, by the seller's name otherwise. */
export const SellerSchema = defineSchema('vet402_seller', {
  kind: str().indexed(),
  seller: str().indexed(),
  pay_to: str().indexed().optional(),
})

/**
 * Points one claim at its box on Swarm. The reference is unencrypted, and the box inside holds no key.
 * vet402 writes it and hands it to the buyer on the claim, so it is read by its creator, never its owner.
 */
export const EvidenceSchema = defineSchema('vet402_evidence', {
  kind: str().indexed(),
  claim_id: str().indexed(),
  gateway_transfer_id: str().indexed(),
  swarm_ref: str(),
  /**
   * Unix seconds the postage batch keeps the box on Swarm, read from vet402's own Bee node when it
   * uploaded the box. A box the public gateway stamped has no such date, so the column is left out.
   */
  swarm_kept_until: u64().optional(),
})

/** Arc's ruling on one claim, copied from the contract's Silent or Fraud event. `seller` is the payTo address, lowercase. */
export const VerdictSchema = defineSchema('vet402_verdict', {
  kind: str().indexed(),
  claim_id: str().indexed(),
  seller: str().indexed(),
  verdict: str(),
  claim_tx: str().optional(),
  contract: str(),
  chain_id: u64(),
})

/** The form every address column holds, so one address always matches itself. */
export const addressColumn = (address: string): string => address.toLowerCase()

/** Rows the live check writes. The receipts screen leaves them out. */
export const LIVE_CHECK_PREFIX = 'live-check-'

/** A str column holds at most 128 bytes. Seller names come from a public catalog, so they are cut to fit. */
export function sellerColumn(name: string): string {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length <= 128) return name
  return new TextDecoder().decode(bytes.slice(0, 128)).replace(/�+$/, '')
}
