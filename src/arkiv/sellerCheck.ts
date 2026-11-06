import { blockToDate } from './receiptsFeed'
import type { BlockTiming } from './receiptsFeed'

/** A ruling stops vet402 paying that address for this long, counted from the block it was written in. */
export const RULING_SECONDS = 604_800

export const ARC_TX = 'https://explorer.testnet.arc.io/tx/'

export const NOT_ADDRESS_LINE = "Paste a seller's 0x address."
export const UNREAD_LINE = 'Could not read Arkiv. Try again.'
export const CLEAR_LINE = 'No ruling from Arc against this seller. Checked on Arkiv just now.'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** One `vet402_verdict` entity against the address that was checked. */
export interface RawRuling {
  verdict: string
  claimId: string
  claimTx: string | null
  /** The block the ruling was written in. */
  createdAt: bigint
}

export interface RulingsRead {
  rulings: RawRuling[]
  timing: BlockTiming
}

export type SellerAnswer =
  | { kind: 'not-address' }
  | { kind: 'unread' }
  | { kind: 'clear' }
  | {
      kind: 'ruled'
      /** The UTC date of the latest ruling. */
      date: string
      verdict: string
      claimId: string
      /** The claim on the Arc explorer, when the ruling carries its transaction. */
      claimUrl: string | null
      /** The UTC date vet402 pays this seller again, while the latest ruling is under 7 days old. */
      notPaidUntil: string | null
    }

export const verdictLabel = (verdict: string) => (verdict ? verdict[0]!.toUpperCase() + verdict.slice(1) : verdict)

export const shortClaim = (claimId: string) => (claimId.length > 10 ? `${claimId.slice(0, 10)}…` : claimId)

export function rulingLine(answer: Extract<SellerAnswer, { kind: 'ruled' }>): string {
  return `Arc ruled against this seller on ${answer.date} (${verdictLabel(answer.verdict)}). Claim ${shortClaim(answer.claimId)} on Arc.`
}

export const notPaidLine = (date: string) => `vet402 does not pay this seller until ${date}.`

/** The latest ruling decides the answer. An older one ends its 7 days sooner. */
export function answerFrom({ rulings, timing }: RulingsRead): SellerAnswer {
  const latest = rulings.reduce<RawRuling | null>((a, b) => (a && a.createdAt >= b.createdAt ? a : b), null)
  if (!latest) return { kind: 'clear' }
  const age = (timing.currentBlock - latest.createdAt) * BigInt(timing.blockDuration)
  const endBlock = latest.createdAt + BigInt(Math.ceil(RULING_SECONDS / timing.blockDuration))
  return {
    kind: 'ruled',
    date: blockToDate(latest.createdAt, timing),
    verdict: latest.verdict,
    claimId: latest.claimId,
    claimUrl: latest.claimTx ? `${ARC_TX}${latest.claimTx}` : null,
    notPaidUntil: age < BigInt(RULING_SECONDS) ? blockToDate(endBlock, timing) : null,
  }
}

/** Answers for whatever was pasted. Only a 0x address is read, and a failed read is an answer of its own. */
export async function checkSeller(input: string, read: (payTo: string) => Promise<RulingsRead>): Promise<SellerAnswer> {
  const payTo = input.trim()
  if (!ADDRESS.test(payTo)) return { kind: 'not-address' }
  try {
    return answerFrom(await read(payTo))
  } catch {
    return { kind: 'unread' }
  }
}
