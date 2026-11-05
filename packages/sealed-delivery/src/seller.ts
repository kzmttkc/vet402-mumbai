// The seller's side: an Express middleware that sits in front of the route that makes the answer.
// It verifies the payment, lets the route answer, seals that answer, signs the promise, settles,
// and returns the box. The key goes out on GET <mount>/key, and a lookout answers claims on chain.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createSellerWatcher } from '../../../server/sealedDelivery'
import { createSealedChain } from './chain'
import type { SealedChain } from './chain'
import { sealAndPromise } from './common'
import type { SealedBox } from './common'

/** The facilitator you already use: Circle's BatchFacilitatorClient or any x402 facilitator client. */
export interface Facilitator {
  verify(payload: unknown, requirements: unknown): Promise<{ isValid: boolean; invalidReason?: string }>
  settle(payload: unknown, requirements: unknown): Promise<{ success: boolean; transaction?: string; errorReason?: string }>
}

/** One x402 payment requirement, as the seller already advertises it. */
export interface PaymentRequirement {
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds?: number
  extra?: Record<string, unknown>
}

export interface SealedDeliveryOptions {
  /** The SealedDelivery deployment the seller has deposited into. */
  contract: Address
  /** Signs promises, receives the payment and answers claims. It must be the deposit's address and accepts.payTo. */
  sellerKey: Hex
  facilitator: Facilitator
  accepts: PaymentRequirement
  /** A node of the contract's chain. */
  rpcUrl: string
  /** Keeps keys across a restart, so an open claim can still be answered. Without it, keys live in memory. */
  storeFile?: string
  /** Answer claims on chain. On by default; the lookout starts with the first sale. */
  watch?: boolean
  watchIntervalMs?: number
  /** How long a promise lives. It must stay under the contract's MAX_EXPIRY. */
  promiseSeconds?: number
  log?: (message: string) => void
  /** For tests: a prepared chain client. */
  chain?: SealedChain
}

interface Stored {
  headerHash: string
  key: Hex
  body: string
  settledHeader: string
}

interface Parsed {
  payload: unknown
  nonce: Hex
  from: Address
  to: string
  value: string
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '')

function parsePayment(header: string): Parsed | null {
  try {
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      payload?: { authorization?: Record<string, unknown> }
    }
    const a = payload.payload?.authorization
    if (!a) return null
    const { nonce, from, to, value } = a
    if (typeof nonce !== 'string' || typeof from !== 'string' || typeof to !== 'string' || typeof value !== 'string') return null
    return { payload, nonce: nonce as Hex, from: from as Address, to, value }
  } catch {
    return null
  }
}

const paymentHeaderOf = (req: Request) => req.get('payment-signature') ?? req.get('x-payment')

/** What the route behind the middleware sent, caught before it reaches the buyer. */
function capture(res: Response): Promise<{ status: number; body: Buffer; contentType: string }> {
  return new Promise((resolve) => {
    const done = (chunk: unknown) => {
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === 'string' ? chunk : chunk == null ? '' : JSON.stringify(chunk))
      resolve({ status: res.statusCode, body, contentType: String(res.get('Content-Type') ?? 'application/octet-stream') })
    }
    // res.json and res.send both end in res.send; a route that calls res.end directly is caught too.
    res.send = ((chunk: unknown) => {
      done(chunk)
      return res
    }) as Response['send']
    res.end = ((chunk?: unknown) => {
      done(typeof chunk === 'function' ? undefined : chunk)
      return res
    }) as Response['end']
  })
}

export function sealedDelivery(options: SealedDeliveryOptions) {
  const seller = privateKeyToAccount(options.sellerKey).address
  if (lower(options.accepts.payTo) !== lower(seller)) {
    throw new Error('accepts.payTo must be the address of sellerKey: the contract pays claims from that deposit.')
  }
  const log = options.log ?? (() => {})
  const chain = options.chain ?? createSealedChain({ contract: options.contract, rpcUrl: options.rpcUrl })

  const stored = new Map<string, Stored>()
  if (options.storeFile && existsSync(options.storeFile)) {
    for (const [nonce, item] of Object.entries(JSON.parse(readFileSync(options.storeFile, 'utf8')) as Record<string, Stored>)) {
      stored.set(nonce, item)
    }
  }
  const remember = (nonce: string, item: Stored) => {
    stored.set(nonce.toLowerCase(), item)
    if (!options.storeFile) return
    mkdirSync(path.dirname(options.storeFile), { recursive: true })
    const temporary = `${options.storeFile}.tmp`
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(stored)), { mode: 0o600 })
    renameSync(temporary, options.storeFile)
  }
  const keyFor = (nonce: string): Hex | null => stored.get(nonce.toLowerCase())?.key ?? null

  let stopWatch: (() => void) | null = null
  const startWatch = () => {
    if (stopWatch || options.watch === false) return
    stopWatch = createSellerWatcher({ client: chain, sellerKey: options.sellerKey, keyFor, mode: 'answer', log }).start(
      options.watchIntervalMs ?? 2000,
    )
  }
  if (stored.size > 0) startWatch()

  // One payment is handled at a time, so it is settled once.
  const queues = new Map<string, Promise<unknown>>()
  const exclusive = <T>(nonce: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(nonce) ?? Promise.resolve()).then(work, work)
    const tail = run.catch(() => undefined)
    queues.set(nonce, tail)
    void tail.then(() => queues.get(nonce) === tail && queues.delete(nonce))
    return run
  }

  function key(req: Request, res: Response) {
    const header = paymentHeaderOf(req)
    const payment = header ? parsePayment(header) : null
    const item = payment ? stored.get(payment.nonce.toLowerCase()) : undefined
    if (!header || !item || item.headerHash !== sha256(header)) {
      res.status(409).json({ error: 'No sealed answer for this payment' })
      return
    }
    res.status(200).json({ key: item.key })
  }

  async function paid(req: Request, res: Response, next: NextFunction) {
    const requirements = {
      x402Version: 2,
      resource: { url: `${req.protocol}://${req.get('host')}${req.originalUrl}`, mimeType: 'application/json' },
      accepts: [options.accepts],
    }
    const reject = (status: number, error?: string) =>
      res.status(status).set('PAYMENT-REQUIRED', b64(requirements)).json({ ...requirements, ...(error ? { error } : {}) })

    const header = paymentHeaderOf(req)
    if (!header) return reject(402)
    const payment = parsePayment(header)
    if (!payment) return reject(402, 'Unreadable payment')
    if (lower(payment.to) !== lower(options.accepts.payTo) || payment.value !== options.accepts.amount) {
      return reject(402, 'Wrong payee or amount')
    }

    await exclusive(payment.nonce.toLowerCase(), async () => {
      const previous = stored.get(payment.nonce.toLowerCase())
      if (previous) {
        // The same settled payment gets the same box again. Another header with this nonce gets nothing.
        if (previous.headerHash !== sha256(header)) return void res.status(409).end()
        return void res.status(200).set({ 'Content-Type': 'application/json', 'PAYMENT-RESPONSE': previous.settledHeader }).send(previous.body)
      }

      const verified = await options.facilitator.verify(payment.payload, options.accepts)
      if (!verified.isValid) return void reject(402, verified.invalidReason ?? 'Payment not valid')

      // Let the route answer, and keep its answer from the buyer until it is sealed and settled.
      const send = res.send.bind(res)
      const end = res.end.bind(res)
      const caught = capture(res)
      next()
      const answer = await caught
      res.send = send
      res.end = end
      if (answer.status >= 400) {
        // The route failed: nothing is settled, so the buyer pays nothing.
        return void res.status(answer.status).type(answer.contentType).send(answer.body)
      }

      const { box, key: sealKey } = await sealAndPromise({
        plaintext: new Uint8Array(answer.body),
        sellerKey: options.sellerKey,
        buyer: payment.from,
        value: BigInt(payment.value),
        paymentNonce: payment.nonce,
        chainId: await chain.chainId(),
        contract: options.contract,
        promiseSeconds: options.promiseSeconds,
      })

      // Sealed before settling: a failure up to here leaves the buyer uncharged.
      const settled = await options.facilitator.settle(payment.payload, options.accepts)
      if (!settled.success) return void reject(402, settled.errorReason ?? 'Payment not settled')

      const body = JSON.stringify({ sealed: box satisfies SealedBox, contentType: answer.contentType })
      const settledHeader = b64({ success: true, transaction: settled.transaction ?? '', network: options.accepts.network, payer: payment.from })
      remember(payment.nonce, { headerHash: sha256(header), key: sealKey, body, settledHeader })
      startWatch()
      res.status(200).set({ 'Content-Type': 'application/json', 'PAYMENT-RESPONSE': settledHeader }).send(body)
    })
  }

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && req.path === '/key') return key(req, res)
    paid(req, res, next).catch((error: unknown) => {
      log(`sealed delivery failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      if (!res.headersSent) res.status(502).json({ error: 'Sealed delivery failed.' })
    })
  }

  return Object.assign(middleware, {
    seller,
    keyFor,
    /** Stops the lookout. */
    close: () => {
      stopWatch?.()
      stopWatch = null
    },
  })
}
