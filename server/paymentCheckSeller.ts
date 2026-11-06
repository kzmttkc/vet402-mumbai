import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { CIRCLE_BATCHING_NAME } from '@circle-fin/x402-batching'
import { keccak256 } from 'viem'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_CAIP2 } from '../src/existing/arc-gateway'
import { formatUsdc } from '../src/onchain-money'
import { detail } from '../src/lib/receiptLines'
import { openResponse } from '../src/lib/sealed'
import { fetchTransfers } from './circleRecord'
import { toCandidate } from './discovery'
import type { Candidate } from './discovery'
import { preparePayment, readBody } from './gatewayPay'
import type { PayOutcome } from './jobs'
import { ANSWER_GAS, createSealer, createSellerWatcher } from './sealedDelivery'
import type { SealedBox, SealedClient, SealedPorts } from './sealedDelivery'
import { createSeller, DEMO_PRICE } from './sellers'
import type { SellerFacilitator } from './sellers'

// vet402 Payment Check: vet402's own seller, which the public agent ranks beside Circle's Arc catalog.
// It reads Circle's record of the agent's last payment and sends the answer sealed under SealedDelivery,
// so the purchase is protected on Arc the same way as the dispute try. The seller listens on 127.0.0.1
// for the length of one purchase, as Seller A does in the dispute try.

export const PAYMENT_CHECK_NAME = 'vet402 Payment Check'
/** Never fetched: the agent buys this seller on 127.0.0.1. The reserved .invalid name means a slip reaches nobody. */
export const PAYMENT_CHECK_RESOURCE = 'https://vet402.invalid/sellers/payment-check'
const DESCRIPTION = "Checks whether your agent's last payment went through, from Circle's record. Protected on Arc by SealedDelivery."

export const DELIVERED_SEALED = "Delivered sealed. Key checked against the seller's promise."
export const DELIVERED_FROM_ARC = "Delivered sealed. The key came through Arc and matches the seller's promise."
export const KEY_CHECKED = 'The key and the answer match the hashes the seller signed for this payment.'
export const CLAIM_OPEN = "The key has not arrived yet. vet402 asked Arc to step in, and the seller's deposit pays you back if the key never comes."
const NOT_SEALED = 'The answer arrived without a valid seal, so it stays closed.'
const NO_KEY = 'The key has not arrived yet.'

/** How long the agent reads the chain for the key after a claim. The function itself may run 60 s. */
export const KEY_WAIT_MS = 30_000

/** The listing as Discovery would carry it, with the contract it seals under in accepts[].extra. */
export function paymentCheckListing(payTo: Address, sealedAddress: Address): Parameters<typeof toCandidate>[0] {
  return {
    resource: PAYMENT_CHECK_RESOURCE,
    type: 'http',
    accepts: [
      {
        scheme: 'exact',
        network: ARC_CAIP2,
        amount: DEMO_PRICE.toString(),
        payTo,
        extra: { name: CIRCLE_BATCHING_NAME, sealedDelivery: sealedAddress },
      },
    ],
    metadata: { provider: { name: PAYMENT_CHECK_NAME, description: DESCRIPTION }, path: '/payment-check', method: 'GET' },
  }
}

/** The candidate, read the same way as a catalog listing, and marked as vet402's own. */
export function paymentCheckCandidate(payTo: Address, sealedAddress: Address): Candidate {
  const candidate = toCandidate(paymentCheckListing(payTo, sealedAddress), ARC_CAIP2)
  if (!candidate) throw new Error('vet402 Payment Check listing is not payable')
  return { ...candidate, own: true }
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** Circle's record of one payment, as the answer reads it. */
interface Row {
  status?: unknown
  amount?: unknown
  toAddress?: unknown
  createdAt?: unknown
}

/**
 * The answer in plain words, from the payer's newest transfer on Circle's record. Payments to `skipTo`, this seller,
 * are left out, so the answer is about the payment before the check and not the check itself.
 */
export function describeLastPayment(transfers: Row[], skipTo?: string): string {
  const skip = skipTo?.toLowerCase()
  const newest = transfers
    .filter((t) => !skip || typeof t.toAddress !== 'string' || t.toAddress.toLowerCase() !== skip)
    .sort((a, b) => Date.parse(String(b.createdAt ?? '')) - Date.parse(String(a.createdAt ?? '')))[0]
  if (!newest) return "Circle's record shows no payments from your agent yet."
  const amount = typeof newest.amount === 'string' && /^\d+$/.test(newest.amount) ? `${formatUsdc(BigInt(newest.amount))} USDC` : 'a payment'
  const to = typeof newest.toAddress === 'string' ? ` to ${short(newest.toAddress)}` : ''
  if (newest.status === 'failed') return `No, your agent's last payment of ${amount}${to} did not go through.`
  if (newest.status === 'completed') return `Yes, your agent's last payment went through. It paid ${amount}${to}, and Arc has settled it.`
  return `Yes, your agent's last payment went through. It paid ${amount}${to}, and Circle is settling it on Arc.`
}

/** Reads the payer's newest transfers from Circle's record and answers. */
export async function lastPaymentFromCircle(payer: string, fetchImpl: typeof fetch = fetch, skipTo?: string): Promise<string> {
  const transfers = await fetchTransfers(`from=${encodeURIComponent(payer)}&network=${ARC_CAIP2}&pageSize=20`, fetchImpl)
  return describeLastPayment(transfers as Row[], skipTo)
}

/** What the agent gets from vet402 Payment Check: the payment as usual, the answer as text, and the receipt's lines. */
export interface OwnPurchase extends PayOutcome {
  data: string
  lines: string[]
}

export interface PaymentCheckOptions {
  /** Signs the seller's promises and runs its lookout. */
  client: Pick<SealedClient, 'signPromise' | 'latestBlock' | 'readClaimed' | 'tryAnswer' | 'chainTime' | 'answer' | 'ensureGas'>
  /** The agent's side of the contract: the box check, the key request and the claim. */
  sealed: Pick<SealedPorts, 'readBox' | 'requestKey' | 'coverageFor' | 'claim' | 'readKey' | 'chainTime'>
  sealedAddress: Address
  /** The agent's hold pays. The seller is a separate wallet with a deposit, and the buyer pays for gas. */
  keys: { hold: Hex; seller: Hex; buyer: Hex }
  facilitator: SellerFacilitator
  holdAvailable: () => Promise<bigint>
  /** The answer for a payer. Defaults to Circle's record. */
  lastPayment?: (payer: string) => Promise<string>
  /** True hands the key over the connection. Tests pass false to take the chain. */
  handsOverKey?: () => boolean
  watchMs?: number
  pollMs?: number
  keyWaitMs?: number
  log?: (message: string) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : String(error))

/** Opens the box with the key. Null when the key is not the promised one. */
function openBox(box: SealedBox, key: Hex): { text: string; matches: boolean } | null {
  if (keccak256(key) !== box.promise.keyHash) return null
  const plain = openResponse(box.ciphertext, key)
  return { text: new TextDecoder().decode(plain), matches: keccak256(plain) === box.promise.plaintextHash }
}

/** The seller's answer from the opened text, which is {"seller": ..., "answer": ...}. */
function answerOf(text: string): string {
  try {
    const answer = (JSON.parse(text) as { answer?: unknown }).answer
    return typeof answer === 'string' ? answer : text
  } catch {
    return text
  }
}

function transactionOf(header: string | null): string {
  if (!header) return ''
  try {
    const settled = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { transaction?: unknown }
    return typeof settled.transaction === 'string' ? settled.transaction : ''
  } catch {
    return ''
  }
}

export function createPaymentCheck(options: PaymentCheckOptions) {
  const { client, sealed, keys } = options
  const log = options.log ?? ((message: string) => console.error(message))
  const seller = privateKeyToAccount(keys.seller).address
  const candidate = paymentCheckCandidate(seller, options.sealedAddress)
  const lastPayment = options.lastPayment ?? ((payer: string) => lastPaymentFromCircle(payer, fetch, seller))
  const sealer = createSealer(client, keys.seller)

  /** The seller and its lookout, on 127.0.0.1, for one purchase. */
  async function openSeller() {
    const handler = createSeller({
      name: PAYMENT_CHECK_NAME,
      payTo: seller,
      declaresRecovery: false,
      facilitator: options.facilitator,
      confirmCharged: () => Promise.resolve(false),
      dropAfterSettle: () => false,
      sealing: {
        // The seller writes its own answer from Circle's record, then seals it. A failed read leaves the buyer uncharged.
        seal: async (_answer, payment) =>
          sealer(JSON.stringify({ seller: PAYMENT_CHECK_NAME, answer: await lastPayment(payment.from) }), payment),
        handsOverKey: options.handsOverKey ?? (() => true),
      },
    })
    const app = express()
    const route = (fn: (req: express.Request, res: express.Response) => Promise<void>) => (req: express.Request, res: express.Response) =>
      void fn(req, res).catch((error: unknown) => {
        log(`payment check seller failed: ${messageOf(error)}`)
        if (!res.headersSent) res.status(502).end()
      })
    app.get('/sellers/payment-check', route(handler))
    app.get('/sellers/payment-check/key', route(handler.key))
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    // The lookout reads its starting block before the payment, so a claim is always after it.
    const watcher = createSellerWatcher({ client, sellerKey: keys.seller, keyFor: handler.keyFor, mode: 'answer', log })
    await watcher.tick()
    const stop = watcher.start(options.watchMs ?? 1000)
    const { port } = server.address() as AddressInfo
    return {
      url: `http://127.0.0.1:${port}/sellers/payment-check`,
      async close() {
        stop()
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      },
    }
  }

  /** Reads the chain until the key is there, the deadline has passed, or the wait is over. */
  async function waitForKey(claim: { claimId: Hex; deadline: bigint; fromBlock: bigint }): Promise<Hex | null> {
    const until = Date.now() + (options.keyWaitMs ?? KEY_WAIT_MS)
    while (Date.now() < until) {
      try {
        const found = await sealed.readKey(claim.claimId, claim.fromBlock)
        if (found) return found.key
        if ((await sealed.chainTime()) >= claim.deadline) return null
      } catch {
        // A failed read is read again.
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000))
    }
    return null
  }

  /** Pays once from the hold, opens the sealed answer with the key, and asks Arc to step in when the key does not come. */
  async function buy(cap: bigint): Promise<OwnPurchase> {
    const host = await openSeller()
    try {
      const challenge = await preparePayment({ holdKey: keys.hold, holdAvailable: options.holdAvailable }, { url: host.url, method: 'GET' }, cap)
      if (challenge.kind !== 'priced') throw new Error('vet402 Payment Check answered without a price')
      const { payment } = challenge
      const paid = await payment.send()
      if (!paid.ok) throw new Error(`Payment failed with status ${paid.status}`)
      const body = await readBody(paid)
      // From here the money has moved, so every ending is a reply and none is an error.
      const base = { paid: payment.amount, nonce: payment.nonce, timesReceived: 1, transaction: transactionOf(paid.headers.get('PAYMENT-RESPONSE')) }

      const read = await sealed.readBox(body, payment)
      if (read.kind !== 'box') return { ...base, data: NOT_SEALED, body, lines: [] }
      const { box } = read

      // The key on its own request. When that works, nothing touches the chain.
      const offered = await sealed.requestKey(host.url, payment)
      const opened = offered ? openBox(box, offered) : null
      if (opened?.matches) return { ...base, data: answerOf(opened.text), body: opened.text, lines: [DELIVERED_SEALED, detail(KEY_CHECKED)] }

      if (!(await sealed.coverageFor(seller, payment.amount).catch(() => false))) return { ...base, data: NO_KEY, body: '', lines: [] }
      let claim: Awaited<ReturnType<SealedPorts['claim']>>
      try {
        // The seller answers a claim from its own wallet, so it gets what that costs first.
        await client.ensureGas(keys.buyer, seller, ANSWER_GAS).catch((error: unknown) => log(`payment check seller gas failed: ${messageOf(error)}`))
        claim = await sealed.claim(box, payment)
      } catch (error) {
        log(`payment check claim failed: ${messageOf(error)}`)
        return { ...base, data: NO_KEY, body: '', lines: [] }
      }
      const key = await waitForKey(claim)
      const fromChain = key ? openBox(box, key) : null
      if (fromChain?.matches) {
        return {
          ...base,
          data: answerOf(fromChain.text),
          body: fromChain.text,
          lines: [DELIVERED_FROM_ARC, detail(`Claim ${claim.claimId} answered on SealedDelivery. ${KEY_CHECKED}`)],
        }
      }
      return { ...base, data: CLAIM_OPEN, body: '', lines: [detail(`Claim ${claim.claimId} is open on SealedDelivery ${options.sealedAddress}.`)] }
    } finally {
      await host.close()
    }
  }

  return { candidate, buy }
}

export type PaymentCheck = ReturnType<typeof createPaymentCheck>
