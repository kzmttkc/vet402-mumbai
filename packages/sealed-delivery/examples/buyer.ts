// The smallest sealed buyer: read the 402, check the cover, pay, then open the box.
import type { Address, Hex } from 'viem'
import { coverageFor, openSealed } from '../src/index'
import type { PaymentRequirement } from '../src/index'

export interface BuyerConfig {
  url: string
  contract: Address
  rpcUrl: string
  buyerKey: Hex
  /** Your x402 client: signs a payment for this requirement and returns the header value. */
  pay: (accept: PaymentRequirement) => Promise<string>
}

export async function buy({ url, contract, rpcUrl, buyerKey, pay }: BuyerConfig) {
  const offer = (await (await fetch(url)).json()) as { accepts: PaymentRequirement[] }
  const accept = offer.accepts[0]!
  if (!(await coverageFor({ contract, rpcUrl }, accept.payTo as Address, BigInt(accept.amount)))) {
    return { status: 'not covered' as const }
  }
  const paymentHeader = await pay(accept)
  return openSealed({ url, paymentHeader, contract, rpcUrl, buyerKey, pollMs: 300 })
}
