import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import {
  ARC_CAIP2,
  ARC_GATEWAY_DOMAIN_NAME,
  ARC_GATEWAY_DOMAIN_VERSION,
  ARC_GATEWAY_MAX_TIMEOUT_SECONDS,
  ARC_GATEWAY_WALLET,
  ARC_USDC,
} from '../src/existing/arc-gateway'
import { parseUsdc } from '../src/onchain-money'

/** Both demo sellers charge 0.001 USDC. */
export const DEMO_PRICE = parseUsdc('0.001')

/** A small seller that exists only for the expiry scene. It charges the same price as the others. */
export const SELLER_C_NAME = 'Seller C'

/** Said by a seller that will give the same paid answer again for the same payment. */
export const RECOVERY_SAME_PAYMENT = 'same-payment'

/** What a seller needs from Gateway. The real one is BatchFacilitatorClient. */
export interface SellerFacilitator {
  verify(payload: unknown, requirements: unknown): Promise<{ isValid: boolean; invalidReason?: string }>
  settle(
    payload: unknown,
    requirements: unknown,
  ): Promise<{ success: boolean; transaction?: string; errorReason?: string }>
}

export interface SellerConfig {
  name: string
  /** The seller's own wallet. Never the hold wallet. */
  payTo: string
  /** Seller A says "recovery": "same-payment". Seller B declares nothing. */
  declaresRecovery: boolean
  facilitator: SellerFacilitator
  /**
   * Seller A asks Circle's record before it gives a stored answer again: exactly one transfer
   * for this payment, not failed, from the payer to this seller, for the price.
   */
  confirmCharged: (nonce: string, payer: string) => Promise<boolean>
  /** The switch: close the connection after settling and before the first response. */
  dropAfterSettle: () => boolean
}

/** Built from constants, because Gateway's supported list does not return this network. */
export function paymentRequired(config: SellerConfig, resourceUrl: string) {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: `${config.name} answer`, mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: ARC_CAIP2,
        // The token contract address, not the symbol.
        asset: ARC_USDC,
        amount: DEMO_PRICE.toString(),
        payTo: config.payTo,
        maxTimeoutSeconds: ARC_GATEWAY_MAX_TIMEOUT_SECONDS,
        extra: {
          name: ARC_GATEWAY_DOMAIN_NAME,
          version: ARC_GATEWAY_DOMAIN_VERSION,
          verifyingContract: ARC_GATEWAY_WALLET,
          ...(config.declaresRecovery ? { recovery: RECOVERY_SAME_PAYMENT } : {}),
        },
      },
    ],
  }
}

interface Stored {
  /** The exact payment header that was settled. Only the same payment gets the stored answer. */
  headerHash: string
  body: string
  settledHeader: string
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '')

interface ParsedPayment {
  payload: unknown
  nonce: string
  from: string
  to: string
  value: string
}

function parsePayment(header: string): ParsedPayment | null {
  try {
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      payload?: { authorization?: Record<string, unknown> }
    }
    const auth = payload.payload?.authorization
    if (!auth) return null
    const { nonce, from, to, value } = auth
    if (typeof nonce !== 'string' || typeof from !== 'string' || typeof to !== 'string' || typeof value !== 'string') {
      return null
    }
    return { payload, nonce, from, to, value }
  } catch {
    return null
  }
}

/** An Express handler for one seller. */
export function createSeller(config: SellerConfig) {
  const stored = new Map<string, Stored>()
  // Requests for the same payment are handled one at a time, so one payment is settled once.
  const queues = new Map<string, Promise<unknown>>()

  function exclusive<T>(nonce: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(nonce) ?? Promise.resolve()).then(work, work)
    const tail = run.catch(() => undefined)
    queues.set(nonce, tail)
    void tail.then(() => {
      if (queues.get(nonce) === tail) queues.delete(nonce)
    })
    return run
  }

  const answer = () => JSON.stringify({ seller: config.name, answer: 'Here is the answer you paid for.' })

  function deliver(res: Response, item: Stored) {
    res.status(200).set({ 'Content-Type': 'application/json', 'PAYMENT-RESPONSE': item.settledHeader }).send(item.body)
  }

  return async function handle(req: Request, res: Response): Promise<void> {
    const requirements = paymentRequired(config, `${req.protocol}://${req.get('host')}${req.originalUrl}`)
    const reject = (status: number, error?: string) => {
      res
        .status(status)
        .set('PAYMENT-REQUIRED', b64(requirements))
        .json(error ? { error } : {})
    }

    const header = req.get('payment-signature')
    if (!header) return reject(402)

    const payment = parsePayment(header)
    if (!payment) return reject(402, 'Unreadable payment')
    const accept = requirements.accepts[0]
    if (lower(payment.to) !== lower(accept?.payTo) || payment.value !== accept?.amount) {
      return reject(402, 'Wrong payee or amount')
    }

    await exclusive(payment.nonce, async () => {
      // Same payment again: give the stored answer back, without verifying or settling again.
      const previous = stored.get(payment.nonce)
      if (config.declaresRecovery && previous) {
        if (previous.headerHash !== sha256(header)) {
          res.status(409).end()
          return
        }
        if (!(await config.confirmCharged(payment.nonce, payment.from))) {
          // Circle's record does not show exactly one good payment. No body.
          res.status(409).end()
          return
        }
        deliver(res, previous)
        return
      }

      const verified = await config.facilitator.verify(payment.payload, accept)
      if (!verified.isValid) return reject(402, verified.invalidReason ?? 'Payment not valid')

      const settled = await config.facilitator.settle(payment.payload, accept)
      if (!settled.success) return reject(402, settled.errorReason ?? 'Payment not settled')

      const item: Stored = {
        headerHash: sha256(header),
        body: answer(),
        settledHeader: b64({ success: true, transaction: settled.transaction ?? '', network: ARC_CAIP2, payer: payment.from }),
      }
      // Stored under the payment nonce, before anything is sent.
      if (config.declaresRecovery) stored.set(payment.nonce, item)

      if (config.dropAfterSettle()) {
        // Settled, but the connection closes before the first response.
        req.socket.destroy()
        return
      }
      deliver(res, item)
    })
  }
}
