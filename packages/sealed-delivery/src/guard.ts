// The seller's guard against a buyer that claims with the key already in hand. Such a claim costs the buyer
// nothing, since the answer repays its gas, and costs an honest seller its answer plus that gas. The record
// below is read from the chain's own events, so a buyer cannot clean it up.
import type { Address, Hex } from 'viem'
import { createSealedChain } from './chain'
import type { ContractRef } from './buyer'

export interface BuyerClaimRecordOptions extends ContractRef {
  /** First block to read. Keep the window recent: a node pages eth_getLogs, and old claims say little. */
  fromBlock: bigint
  /** How many of the buyer's latest claims to look at. Default 5. */
  last?: number
  /** Count only claims against this seller. By default claims against every seller of the deployment count. */
  seller?: Address
  /** Blocks per eth_getLogs call. Default 10,000. */
  blockStep?: bigint
}

export interface BuyerClaimRecord {
  buyer: Address
  /** Every claim the buyer filed since fromBlock. */
  claims: number
  /** The latest `last` claims, newest first. `answered` is true when a seller put the key on chain for it. */
  recent: { claimId: Hex; seller: Address; block: bigint; answered: boolean }[]
  /** How many of `recent` ended with an answer: the seller had the key and handed it over. */
  answered: number
}

const DEFAULT_LAST = 5

/** Reads, from Claimed and KeyRevealed, how often this buyer claimed and how often the seller then answered. */
export async function buyerClaimRecord(buyer: Address, options: BuyerClaimRecordOptions): Promise<BuyerClaimRecord> {
  const chain = options.chain ?? createSealedChain(options)
  const last = options.last ?? DEFAULT_LAST
  const all = await chain.readClaimsBy(buyer, options.fromBlock, { seller: options.seller, blockStep: options.blockStep })
  const latest = last > 0 ? all.slice(-last).reverse() : []
  const oldest = latest[latest.length - 1]?.block ?? options.fromBlock
  const answeredIds = await chain.readAnswered(
    latest.map((c) => c.claimId),
    oldest,
    options.blockStep,
  )
  const recent = latest.map((c) => ({ ...c, answered: answeredIds.has(c.claimId.toLowerCase() as Hex) }))
  return { buyer, claims: all.length, recent, answered: recent.filter((c) => c.answered).length }
}

/**
 * The middleware's option. A buyer whose latest claims mostly ended in an answer is treated as one that claims
 * with the key in hand. Off unless set.
 */
export interface ClaimGuard {
  /** First block to read claims from, or a function that picks it (for example the latest block less a day). */
  fromBlock: bigint | (() => Promise<bigint>)
  /** How many of the buyer's latest claims to look at. Default 5. */
  last?: number
  /** A buyer with at least this many answered claims among them is guarded. Default 3. */
  answeredAtLeast?: number
  /** Count only claims against this seller. By default every seller of the deployment counts. */
  thisSellerOnly?: boolean
  /**
   * 'refuse' (default): no sealed box for this buyer. Nothing is settled, so the buyer is not charged, and it gets
   * a 403 that says why. `{ surcharge }`: this buyer's sealed box costs the price plus `surcharge`, in USDC units.
   * A payment of the plain price gets a 402 that asks for the higher amount, and nothing is settled.
   */
  action?: 'refuse' | { surcharge: bigint }
  /** How long one buyer's verdict is reused, in milliseconds. Default 60,000. */
  cacheMs?: number
}

export const GUARD_DEFAULTS = { last: DEFAULT_LAST, answeredAtLeast: 3, cacheMs: 60_000 } as const

/** True when this record says the buyer should get the guard's action. */
export function isGuarded(record: BuyerClaimRecord, guard: Pick<ClaimGuard, 'answeredAtLeast'>): boolean {
  return record.answered >= (guard.answeredAtLeast ?? GUARD_DEFAULTS.answeredAtLeast)
}
