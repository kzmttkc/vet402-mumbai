// What the seller and the buyer share: the ABI, the Promise and its EIP-712 signature, and the sealing.
// The sealing, the ABI and the payment parsing are the app's own code, imported and not copied.
import { keccak256, parseAbi, recoverTypedDataAddress } from 'viem'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  boxToPromise,
  CLAIMED_EVENTS,
  claimIdOf,
  paymentAuthOf,
  PROMISE_SECONDS,
  revertNameOf,
  SEALED_ABI,
} from '../../../server/sealedDelivery'
import type { PaymentAuth, SealedBox, SealedPromise } from '../../../server/sealedDelivery'
import { openResponse, sealResponse } from '../../../src/lib/sealed'
import type { SealedResponse } from '../../../src/lib/sealed'

export { boxToPromise, CLAIMED_EVENTS, claimIdOf, openResponse, paymentAuthOf, PROMISE_SECONDS, revertNameOf, sealResponse }
export type { PaymentAuth, SealedBox, SealedPromise, SealedResponse }

/** The full ABI: the app's calls plus the reads and seller calls an outside builder needs. */
export const SEALED_DELIVERY_ABI = [
  ...SEALED_ABI,
  ...CLAIMED_EVENTS.slice(1),
  ...parseAbi([
    'function USDC() view returns (address)',
    'function FOLLOW_UP_GAS() view returns (uint256)',
    'function MAX_GAS_PRICE() view returns (uint256)',
    'function MAX_EXPIRY() view returns (uint256)',
    'function ANSWER_WINDOW() view returns (uint256)',
    'function COOLDOWN() view returns (uint256)',
    'function openLiability(address seller) view returns (uint256)',
    'function requestWithdraw(uint256 amount)',
    'function withdrawDeposit()',
  ]),
] as const

/** The contract's PROMISE_TYPEHASH, field for field. */
export const PROMISE_TYPES = {
  Promise: [
    { name: 'seller', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'paymentNonce', type: 'bytes32' },
    { name: 'keyHash', type: 'bytes32' },
    { name: 'plaintextHash', type: 'bytes32' },
    { name: 'ciphertextHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
    { name: 'buyer', type: 'address' },
  ],
} as const

export const promiseDomain = (chainId: number, contract: Address) =>
  ({ name: 'SealedDelivery', version: '1', chainId, verifyingContract: contract }) as const

export function signPromise(sellerKey: Hex, promise: SealedPromise, chainId: number, contract: Address): Promise<Hex> {
  return privateKeyToAccount(sellerKey).signTypedData({
    domain: promiseDomain(chainId, contract),
    types: PROMISE_TYPES,
    primaryType: 'Promise',
    message: promise,
  })
}

/** The address that signed the promise, or null when the signature does not recover. */
export async function promiseSigner(
  promise: SealedPromise,
  signature: Hex,
  chainId: number,
  contract: Address,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      domain: promiseDomain(chainId, contract),
      types: PROMISE_TYPES,
      primaryType: 'Promise',
      message: promise,
      signature,
    })
  } catch {
    return null
  }
}

/** Seals a response and signs the promise for one buyer and one payment. Returns the box and the key. */
export async function sealAndPromise(input: {
  plaintext: string | Uint8Array
  sellerKey: Hex
  buyer: Address
  value: bigint
  paymentNonce: Hex
  chainId: number
  contract: Address
  promiseSeconds?: number
  now?: number
}): Promise<{ box: SealedBox; key: Hex }> {
  const sealed = sealResponse(input.plaintext)
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const promise: SealedPromise = {
    seller: privateKeyToAccount(input.sellerKey).address,
    value: input.value,
    paymentNonce: input.paymentNonce,
    keyHash: sealed.keyHash,
    plaintextHash: sealed.plaintextHash,
    ciphertextHash: sealed.ciphertextHash,
    expiry: BigInt(now + (input.promiseSeconds ?? PROMISE_SECONDS)),
    buyer: input.buyer,
  }
  const sellerSignature = await signPromise(input.sellerKey, promise, input.chainId, input.contract)
  return {
    box: {
      ciphertext: sealed.ciphertext,
      promise: { ...promise, value: promise.value.toString(), expiry: promise.expiry.toString() },
      sellerSignature,
    },
    key: sealed.key,
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Null when the box is what this payment should get: signed by the payee, for this buyer, nonce and
 * price, with the right ciphertext hash and an expiry still ahead. Otherwise the first thing wrong.
 */
export async function checkBox(
  box: SealedBox,
  auth: Pick<PaymentAuth, 'from' | 'to' | 'value' | 'nonce'>,
  chainId: number,
  contract: Address,
  now = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  let promise: SealedPromise
  try {
    promise = boxToPromise(box)
  } catch {
    return 'unreadable promise'
  }
  const signer = await promiseSigner(promise, box.sellerSignature, chainId, contract)
  if (!signer || !same(signer, auth.to)) return 'not signed by the payee'
  if (!same(promise.seller, auth.to)) return 'wrong seller'
  if (!same(promise.buyer, auth.from)) return 'wrong buyer'
  if (!same(promise.paymentNonce, auth.nonce)) return 'wrong nonce'
  if (promise.value !== auth.value) return 'wrong value'
  if (!same(keccak256(box.ciphertext), promise.ciphertextHash)) return 'wrong ciphertext'
  if (promise.expiry <= BigInt(now)) return 'promise expired'
  return null
}

/** Opens a box with a key. Null when the key is not the promised one. */
export function openBox(box: SealedBox, key: Hex): { bytes: Uint8Array; matches: boolean } | null {
  if (!same(keccak256(key), box.promise.keyHash)) return null
  const bytes = openResponse(box.ciphertext, key)
  return { bytes, matches: same(keccak256(bytes), box.promise.plaintextHash) }
}
