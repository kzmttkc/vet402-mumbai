import { BatchEvmScheme } from '@circle-fin/x402-batching/client'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ARC_GATEWAY_DOMAIN_NAME,
  ARC_GATEWAY_DOMAIN_VERSION,
  ARC_GATEWAY_WALLET,
  arcGatewayAcceptWithSellerExtra,
  encodePaymentHeader,
} from '../src/existing/arc-gateway'
import type { ChallengeAccept, Eip3009Authorization } from '../src/existing/arc-gateway'
import type { PayOutcome } from './jobs'
import type { PlannedRequest } from './planner'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 1_000_000

export interface HoldPayer {
  /** The hold key. It is the agent's only spending wallet, so it is the only key that ever signs. */
  holdKey: Hex
  /** What the hold can still spend, in atomic USDC units. */
  holdAvailable: () => Promise<bigint>
  /** For tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

const decode = (header: string): unknown => JSON.parse(Buffer.from(header, 'base64').toString('utf8'))

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * Pays one resource once from the hold, through Gateway batched settlement. This is the pay
 * route's only payment path, and it runs vet402's own Gateway code: the seller's accept must
 * pass arcGatewayAcceptWithSellerExtra, and the header is built by encodePaymentHeader.
 *
 * It runs on the server on purpose. A seller's 402 answer carries its payment terms in a
 * PAYMENT-REQUIRED header that can be around 10,000 characters, which the browser has no
 * business handling. The browser only ever gets the result.
 */
export async function payFromHold(
  { holdKey, holdAvailable, fetchImpl = fetch }: HoldPayer,
  request: PlannedRequest,
  cap: bigint,
): Promise<PayOutcome> {
  const send = (extraHeaders: Record<string, string>) =>
    fetchImpl(request.url, {
      method: request.method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      // A catalog URL must not be able to bounce the agent to another address.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

  // 1. Ask without paying. Only a 402 with payment terms moves on.
  const challenge = await send({})
  if (challenge.status !== 402) {
    if (!challenge.ok) throw new Error(`Request failed with status ${challenge.status}`)
    // Answered without asking for money: nothing was paid.
    const text = await readBody(challenge)
    return { data: parseBody(text), body: text, paid: 0n, nonce: null, timesReceived: 0, transaction: '' }
  }
  const requiredHeader = challenge.headers.get('PAYMENT-REQUIRED')
  if (!requiredHeader) throw new Error('Missing PAYMENT-REQUIRED header in 402 response')
  const required = asRecord(decode(requiredHeader))
  if (!required || !Array.isArray(required.accepts)) throw new Error('No payment options in 402 response')

  // 2. vet402's checks, then the seller's own extra back in. The first accept that passes is used.
  let accept: ChallengeAccept | null = null
  for (const raw of required.accepts) {
    accept = arcGatewayAcceptWithSellerExtra(raw)
    if (accept) break
  }
  if (!accept) throw new Error('No payment option this agent may sign')

  // 3. The hold: at most the approved amount, and never more than the hold has.
  const amount = BigInt(accept.amount)
  if (amount > cap) throw new Error('Price is above the approved amount')
  if (amount > (await holdAvailable())) throw new Error('The hold does not cover this price')

  // 4. Sign with the hold key. The signing domain is the pinned wallet, whatever spelling the seller used.
  const signer = new BatchEvmScheme(privateKeyToAccount(holdKey))
  const signed = await signer.createPaymentPayload(2, {
    scheme: accept.scheme,
    network: accept.network,
    asset: accept.asset,
    amount: accept.amount,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 0,
    extra: { name: ARC_GATEWAY_DOMAIN_NAME, version: ARC_GATEWAY_DOMAIN_VERSION, verifyingContract: ARC_GATEWAY_WALLET },
  })
  const payload = signed.payload as { signature: string; authorization: Eip3009Authorization }

  // 5. Pay once.
  const { headerName, headerValue } = encodePaymentHeader({
    x402Version: 2,
    accept,
    payload,
    resourceUrl: request.url,
    resource: asRecord(required.resource) ?? undefined,
  })
  const paid = await send({ [headerName]: headerValue })
  if (!paid.ok) throw new Error(`Payment failed with status ${paid.status}`)

  const settledHeader = paid.headers.get('PAYMENT-RESPONSE')
  const settled = settledHeader ? asRecord(decode(settledHeader)) : null
  const text = await readBody(paid)

  return {
    data: parseBody(text),
    body: text,
    paid: amount,
    nonce: payload.authorization.nonce,
    timesReceived: 1,
    transaction: typeof settled?.transaction === 'string' ? settled.transaction : '',
  }
}

async function readBody(res: Response): Promise<string> {
  const text = await res.text()
  if (text.length > MAX_RESPONSE_CHARS) throw new Error('The answer was too large')
  return text
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
