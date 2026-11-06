// The buyer's side: read the cover before paying, then open the box, and go to the chain only when the key does not come.
import { keccak256 } from 'viem'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createSealedChain } from './chain'
import type { SealedChain } from './chain'
import { checkBox, openBox, paymentAuthOf } from './common'
import type { SealedBox } from './common'

export interface ContractRef {
  contract: Address
  rpcUrl: string
  /** For tests: a prepared chain client. */
  chain?: SealedChain
}

/** True when the seller's free deposit covers the most a dispute over this price can cost: 2 * (value + MAX_DISPUTE_COST). Read it before paying. */
export function coverageFor(ref: ContractRef, seller: Address, value: bigint): Promise<boolean> {
  return (ref.chain ?? createSealedChain(ref)).coverageFor(seller, value)
}

export interface OpenSealedOptions extends ContractRef {
  /** The paid resource. The key is asked for at the same path plus /key. */
  url: string
  /** The x402 payment header the buyer already signed (base64 JSON with payload.authorization and payload.signature). */
  paymentHeader: string
  /** The key that signed the payment. Needed only to claim, since claim() must come from the payer. */
  buyerKey?: Hex
  /** How many times to ask for the key before going to the chain. */
  keyTries?: number
  pollMs?: number
  fetch?: typeof fetch
  log?: (message: string) => void
}

export type OpenSealedResult = {
  /** opened: the answer matches the promise. silent: no key by the deadline. fraud: the key opened something else. */
  status: 'opened' | 'silent' | 'fraud'
  /** The answer as text, or null when it was not delivered as promised. */
  text: string | null
  bytes: Uint8Array | null
  /** Where the key came from. */
  via: 'key-route' | 'chain' | null
  claimId: Hex | null
  /** What the contract credited the buyer (withdrawClaimable sends it). */
  credited: bigint
  box: SealedBox
}

const HEADER = 'PAYMENT-SIGNATURE'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function keyUrlOf(url: string): string {
  const u = new URL(url)
  u.pathname = `${u.pathname.replace(/\/$/, '')}/key`
  return u.toString()
}

export async function openSealed(options: OpenSealedOptions): Promise<OpenSealedResult> {
  const doFetch = options.fetch ?? fetch
  const log = options.log ?? (() => {})
  const chain = options.chain ?? createSealedChain({ contract: options.contract, rpcUrl: options.rpcUrl, pollingMs: options.pollMs })
  const { auth, signature } = paymentAuthOf(options.paymentHeader)

  const res = await doFetch(options.url, { headers: { [HEADER]: options.paymentHeader } })
  if (!res.ok) throw new Error(`The seller answered ${res.status}`)
  const box = ((await res.json()) as { sealed?: SealedBox }).sealed
  if (!box) throw new Error('The answer is not a sealed box')
  const wrong = await checkBox(box, auth, await chain.chainId(), options.contract)
  if (wrong) throw new Error(`The box does not belong to this payment: ${wrong}`)

  const result = (r: Partial<OpenSealedResult> & Pick<OpenSealedResult, 'status'>): OpenSealedResult => ({
    text: null, bytes: null, via: null, claimId: null, credited: 0n, box, ...r,
  })

  // 1. Ask for the key off chain.
  let key: Hex | null = null
  for (let i = 0; i < (options.keyTries ?? 2) && !key; i++) {
    try {
      const k = await doFetch(keyUrlOf(options.url), { headers: { [HEADER]: options.paymentHeader } })
      const body = k.ok ? ((await k.json()) as { key?: unknown }) : {}
      if (typeof body.key === 'string' && keccak256(body.key as Hex) === box.promise.keyHash) key = body.key as Hex
    } catch {
      // A dropped connection counts as no key.
    }
  }
  if (key) {
    const opened = openBox(box, key)!
    if (opened.matches) return result({ status: 'opened', text: new TextDecoder().decode(opened.bytes), bytes: opened.bytes, via: 'key-route' })
  }

  // 2. No key, or a key that opens something else: claim. Only the payer can.
  if (!options.buyerKey) throw new Error('The key did not come and there is no buyerKey to claim with')
  if (privateKeyToAccount(options.buyerKey).address.toLowerCase() !== auth.from.toLowerCase()) {
    throw new Error('buyerKey is not the key that signed the payment')
  }
  const claimed = await chain.claim(options.buyerKey, box, auth, signature)
  log(`claimed ${claimed.claimId}`)

  const proveWith = async (k: Hex) => {
    const credited = await chain.prove(options.buyerKey!, claimed.claimId, box.ciphertext, k)
    return result({ status: 'fraud', via: 'chain', claimId: claimed.claimId, credited })
  }
  if (key) return proveWith(key)

  // 3. Wait for the key on chain until the deadline, then finalize.
  for (;;) {
    const revealed = await chain.readKeyRevealed(claimed.claimId, claimed.fromBlock)
    if (revealed) {
      const opened = openBox(box, revealed.key)!
      if (!opened.matches) return proveWith(revealed.key)
      return result({ status: 'opened', text: new TextDecoder().decode(opened.bytes), bytes: opened.bytes, via: 'chain', claimId: claimed.claimId })
    }
    if ((await chain.chainTime()) >= claimed.deadline) break
    await sleep(options.pollMs ?? 1000)
  }
  const credited = await chain.finalize(options.buyerKey, claimed.claimId)
  return result({ status: 'silent', claimId: claimed.claimId, credited })
}
