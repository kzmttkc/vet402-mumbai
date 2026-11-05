import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Request, Response } from 'express'
import type { Hex } from 'viem'
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
  /** With this, answers and keys survive a restart, so an open claim can still be answered. */
  storeFile?: string
  /** With this, the paid answer is a sealed box and the key comes on a separate request. */
  sealing?: SellerSealing
}

/** How a seller seals. Without it the seller answers in the clear, as it always did. */
export interface SellerSealing {
  seal(answer: string, payment: { from: string; nonce: string; value: string }): Promise<{ box: unknown; key: Hex }>
  /** False closes the connection when the key is asked for. The switch, or a seller that never hands it over. */
  handsOverKey: () => boolean
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
  /** The key for the sealed answer. Only a seller that seals has one. */
  key?: Hex
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

function readStored(file: string): [string, Stored][] {
  if (!existsSync(file)) return []
  return Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, Stored>)
}

function writeStored(file: string, stored: Map<string, Stored>): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(Object.fromEntries(stored)), { mode: 0o600 })
  renameSync(temporary, file)
}

/** An Express handler for one seller. A sealing seller also has `key` for the key request, and `keyFor` for its lookout. */
export function createSeller(config: SellerConfig) {
  const stored = new Map<string, Stored>(config.storeFile ? readStored(config.storeFile) : [])
  const remember = (nonce: string, item: Stored) => {
    stored.set(nonce, item)
    if (config.storeFile) writeStored(config.storeFile, stored)
  }
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

  async function handle(req: Request, res: Response): Promise<void> {
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

      // Sealed before settling: a failure here leaves the buyer uncharged.
      const sealed = config.sealing
        ? await config.sealing.seal(answer(), { from: payment.from, nonce: payment.nonce, value: payment.value })
        : null

      const settled = await config.facilitator.settle(payment.payload, accept)
      if (!settled.success) return reject(402, settled.errorReason ?? 'Payment not settled')

      const item: Stored = {
        headerHash: sha256(header),
        body: sealed ? JSON.stringify({ seller: config.name, sealed: sealed.box }) : answer(),
        ...(sealed ? { key: sealed.key } : {}),
        settledHeader: b64({ success: true, transaction: settled.transaction ?? '', network: ARC_CAIP2, payer: payment.from }),
      }
      // Stored under the payment nonce, before anything is sent.
      if (config.declaresRecovery || sealed) remember(payment.nonce, item)

      if (config.dropAfterSettle()) {
        // Settled, but the connection closes before the first response.
        req.socket.destroy()
        return
      }
      deliver(res, item)
    })
  }

  /** The key request. Only the exact payment that was settled gets the key. */
  async function key(req: Request, res: Response): Promise<void> {
    const header = req.get('payment-signature')
    const payment = header ? parsePayment(header) : null
    const item = payment ? stored.get(payment.nonce) : undefined
    if (!header || !item?.key || item.headerHash !== sha256(header)) {
      res.status(409).end()
      return
    }
    if (!config.sealing?.handsOverKey()) {
      req.socket.destroy()
      return
    }
    res.status(200).json({ key: item.key })
  }

  return Object.assign(handle, {
    key,
    keyFor: (nonce: string): Hex | null => stored.get(nonce)?.key ?? null,
  })
}
