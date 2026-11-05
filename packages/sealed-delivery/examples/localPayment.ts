// Stand-ins for a local run only: a Gateway-style payment signature and a facilitator that checks it.
// A real seller passes Circle's BatchFacilitatorClient, and a real buyer signs with its x402 client.
import { verifyTypedData } from 'viem'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Facilitator, PaymentRequirement } from '../src/index'

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** The payment domain the contract was deployed with: name, version "1", this chain, the Gateway wallet. */
export interface PaymentDomain {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

export function createLocalPayer(buyerKey: Hex, domain: PaymentDomain) {
  return async (accept: PaymentRequirement): Promise<string> => {
    const account = privateKeyToAccount(buyerKey)
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Hex
    const message = {
      from: account.address,
      to: accept.payTo as Address,
      value: BigInt(accept.amount),
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce,
    }
    const signature = await account.signTypedData({ domain, types: TYPES, primaryType: 'TransferWithAuthorization', message })
    const authorization = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, v.toString()]))
    return Buffer.from(JSON.stringify({ x402Version: 2, accepted: accept, payload: { authorization, signature } })).toString('base64')
  }
}

/** Checks the buyer's signature and settles each nonce once. `settled` lists what went through. */
export function createLocalFacilitator(domain: PaymentDomain) {
  const settled = new Set<string>()
  const authOf = (payload: unknown) =>
    (payload as { payload: { authorization: Record<string, string>; signature: Hex } }).payload
  const facilitator: Facilitator = {
    async verify(payload) {
      const { authorization: a, signature } = authOf(payload)
      if (settled.has(a.nonce!)) return { isValid: false, invalidReason: 'nonce used' }
      const ok = await verifyTypedData({
        address: a.from as Address,
        domain,
        types: TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: a.from as Address,
          to: a.to as Address,
          value: BigInt(a.value!),
          validAfter: BigInt(a.validAfter!),
          validBefore: BigInt(a.validBefore!),
          nonce: a.nonce as Hex,
        },
        signature,
      })
      return ok ? { isValid: true } : { isValid: false, invalidReason: 'bad signature' }
    },
    async settle(payload) {
      const nonce = authOf(payload).authorization.nonce!
      if (settled.has(nonce)) return { success: false, errorReason: 'nonce used' }
      settled.add(nonce)
      return { success: true, transaction: `local-${settled.size}` }
    },
  }
  return { facilitator, settled }
}
