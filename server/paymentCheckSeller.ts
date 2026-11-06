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
import { ANSWER_GAS, createSealer, createSellerWatcher, linksOf } from './sealedDelivery'
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

// The receipt reads in plain words first. The lines that name the seal and the key go under Details.
export const DELIVERED_SEALED = "Delivered sealed. Key checked against the seller's promise."
export const DELIVERED_FROM_ARC = "Delivered sealed. The key came through Arc and matches the seller's promise."
export const KEY_CHECKED = 'The key and the answer match the hashes the seller signed for this payment.'
export const CLAIM_OPEN = "The answer has not arrived yet. vet402 asked Arc to step in, and the seller's deposit pays you back if it never comes."
const NOT_SEALED = 'The answer arrived without a valid seal, so it stays closed.'
const NO_KEY = 'The answer has not arrived yet.'

/** The receipt's plain line when the person tried the dropped line and the key came through Arc. */
export const LINE_DROPPED_ANSWERED = 'The line dropped. vet402 asked Arc, the seller answered there, and you got your answer. Charged once.'

/** The receipt's first line, from the amount actually paid. */
export const answerChecked = (paid: bigint) => `Answer received and checked. You paid ${formatUsdc(paid)} USDC once.`

/** How long the agent reads the chain for the key after a claim. The function itself may run 60 s. */
export const KEY_WAIT_MS = 30_000

/** What tells one of vet402's own sealed sellers apart. The wallet, the contract and the price are shared. */
export interface OwnSellerSpec {
  name: string
  /** Never fetched: the agent buys it on 127.0.0.1, at this URL's path. */
  resource: string
  /** The listing's path, e.g. "/payment-check". */
  path: string
  /** The listing's words, which the agent ranks the same way as a catalog listing. */
  description: string
  /** The card's sentence. Absent leaves the planner's own. */
  summary?: string
}

const PAYMENT_CHECK: OwnSellerSpec = { name: PAYMENT_CHECK_NAME, resource: PAYMENT_CHECK_RESOURCE, path: '/payment-check', description: DESCRIPTION }

/** The listing as Discovery would carry it, with the contract it seals under in accepts[].extra. */
export function ownListing(spec: OwnSellerSpec, payTo: Address, sealedAddress: Address): Parameters<typeof toCandidate>[0] {
  return {
    resource: spec.resource,
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
    metadata: { provider: { name: spec.name, description: spec.description }, path: spec.path, method: 'GET' },
  }
}

/** The candidate, read the same way as a catalog listing, and marked as vet402's own. */
export function ownCandidate(spec: OwnSellerSpec, payTo: Address, sealedAddress: Address): Candidate {
  const candidate = toCandidate(ownListing(spec, payTo, sealedAddress), ARC_CAIP2)
  if (!candidate) throw new Error(`${spec.name} listing is not payable`)
  return { ...candidate, own: true }
}

export const paymentCheckListing = (payTo: Address, sealedAddress: Address) => ownListing(PAYMENT_CHECK, payTo, sealedAddress)

export const paymentCheckCandidate = (payTo: Address, sealedAddress: Address): Candidate => ownCandidate(PAYMENT_CHECK, payTo, sealedAddress)

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** Circle's record of one payment, as the answer reads it. */
interface Row {
  status?: unknown
  amount?: unknown
  toAddress?: unknown
  createdAt?: unknown
}

/** A Discovery listing as the answer reads it: who it pays and the seller's name. */
export interface NamedListing {
  payTo: string | null
  sellerName: string
}

/** The catalog the agent ranks, for the seller names in the answer. */
export type SellerNames = () => Promise<readonly NamedListing[]>

/** The names are waited for at most this long. Past it the answer names the short address, as before. */
export const NAMES_WAIT_MS = 2_000
const MAX_NAME = 60

/**
 * The seller's name for a payee, from the listings that pay it. Null when no listing pays it, when two listings
 * that pay it disagree on the name, or when the name could pass as one of vet402's own sellers.
 */
export function sellerNameFor(listings: readonly NamedListing[], address: string): string | null {
  const names = new Set(
    listings.filter((l) => typeof l.payTo === 'string' && l.payTo.toLowerCase() === address.toLowerCase()).map((l) => l.sellerName.trim()),
  )
  if (names.size !== 1) return null
  const [name] = [...names] as [string]
  if (!name || name.length > MAX_NAME || /^vet402\b/i.test(name)) return null
  return name
}

/**
 * The answer in plain words, from the payer's newest transfer on Circle's record. Payments to `skipTo`, this seller,
 * are left out, so the answer is about the payment before the check and not the check itself. The payee is named by
 * its seller name in `listings` when it has one there, and by its short address otherwise.
 */
export function describeLastPayment(transfers: Row[], skipTo?: string, listings: readonly NamedListing[] = []): string {
  const skip = skipTo?.toLowerCase()
  const newest = transfers
    .filter((t) => !skip || typeof t.toAddress !== 'string' || t.toAddress.toLowerCase() !== skip)
    .sort((a, b) => Date.parse(String(b.createdAt ?? '')) - Date.parse(String(a.createdAt ?? '')))[0]
  if (!newest) return "Circle's record shows no payments from your agent yet."
  const amount = typeof newest.amount === 'string' && /^\d+$/.test(newest.amount) ? `${formatUsdc(BigInt(newest.amount))} USDC` : 'a payment'
  const to = typeof newest.toAddress === 'string' ? ` to ${sellerNameFor(listings, newest.toAddress) ?? short(newest.toAddress)}` : ''
  if (newest.status === 'failed') return `No, your agent's last payment of ${amount}${to} did not go through.`
  if (newest.status === 'completed') return `Yes, your agent's last payment went through. It paid ${amount}${to}, and Arc has settled it.`
  return `Yes, your agent's last payment went through. It paid ${amount}${to}, and Circle is settling it on Arc.`
}

/** The listings for the names, or none when they fail or take longer than `waitMs`. Never throws. */
export async function listingsWithin(sellerNames: SellerNames | undefined, waitMs = NAMES_WAIT_MS): Promise<readonly NamedListing[]> {
  if (!sellerNames) return []
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<readonly NamedListing[]>((resolve) => {
    timer = setTimeout(() => resolve([]), waitMs)
  })
  try {
    return await Promise.race([sellerNames().catch(() => []), late])
  } finally {
    clearTimeout(timer)
  }
}

/** Reads the payer's newest transfers from Circle's record and answers. The names are read beside it, so they add no wait when cached. */
export async function lastPaymentFromCircle(payer: string, fetchImpl: typeof fetch = fetch, skipTo?: string, sellerNames?: SellerNames): Promise<string> {
  const [transfers, listings] = await Promise.all([
    fetchTransfers(`from=${encodeURIComponent(payer)}&network=${ARC_CAIP2}&pageSize=20`, fetchImpl),
    listingsWithin(sellerNames),
  ])
  return describeLastPayment(transfers as Row[], skipTo, listings)
}

/** What the agent gets from one of vet402's own sellers: the payment as usual, the answer as text, and the receipt's lines. */
export interface OwnPurchase extends PayOutcome {
  data: string
  lines: string[]
}

export interface OwnSellerOptions {
  /** Signs the seller's promises and runs its lookout. The address and chain id go into the answer's memo. */
  client: Pick<SealedClient, 'signPromise' | 'latestBlock' | 'readClaimed' | 'tryAnswer' | 'chainTime' | 'answer' | 'ensureGas' | 'address' | 'chainId'>
  /** The agent's side of the contract: the box check, the key request, the claim, and what the answer repaid. */
  sealed: Pick<SealedPorts, 'readBox' | 'requestKey' | 'coverageFor' | 'claim' | 'readKey' | 'chainTime' | 'claimGasRepaid'>
  sealedAddress: Address
  /** The agent's hold pays. The seller is a separate wallet with a deposit, and the buyer pays for gas. */
  keys: { hold: Hex; seller: Hex; buyer: Hex }
  facilitator: SellerFacilitator
  holdAvailable: () => Promise<bigint>
  /** True hands the key over the connection. Tests pass false to take the chain. */
  handsOverKey?: () => boolean
  watchMs?: number
  pollMs?: number
  keyWaitMs?: number
  log?: (message: string) => void
}

/** The payment an own seller answers for. It is verified and not yet settled when the answer is written. */
export interface OwnPayment {
  from: string
  /** Atomic USDC units, as a decimal string. */
  value: string
}

export interface PaymentCheckOptions extends OwnSellerOptions {
  /** The answer for a payer. Defaults to Circle's record. */
  lastPayment?: (payer: string) => Promise<string>
  /** The catalog the agent ranks, so the answer names the seller it paid. Absent names the short address. */
  sellerNames?: SellerNames
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

/**
 * One of vet402's own sealed sellers. It writes `answer` for the payer, seals it under SealedDelivery from the
 * seller's wallet, and the agent buys it once from the hold. Payment Check and Balance Check differ only in `spec` and `answer`.
 */
export function createOwnSealedSeller(spec: OwnSellerSpec, answer: (payment: OwnPayment, seller: Address) => Promise<string>, options: OwnSellerOptions) {
  const { client, sealed, keys } = options
  const log = options.log ?? ((message: string) => console.error(message))
  const seller = privateKeyToAccount(keys.seller).address
  const candidate = ownCandidate(spec, seller, options.sealedAddress)
  const sealer = createSealer(client, keys.seller)
  const path = new URL(spec.resource).pathname

  /** The seller and its lookout, on 127.0.0.1, for one purchase. `handsOverKey` false keeps the key off the connection. */
  async function openSeller(handsOverKey: () => boolean) {
    const handler = createSeller({
      name: spec.name,
      payTo: seller,
      declaresRecovery: false,
      facilitator: options.facilitator,
      confirmCharged: () => Promise.resolve(false),
      dropAfterSettle: () => false,
      sealing: {
        // The seller writes its own answer from Circle, then seals it. A failed read leaves the buyer uncharged.
        seal: async (_answer, payment) => sealer(JSON.stringify({ seller: spec.name, answer: await answer(payment, seller) }), payment),
        handsOverKey,
      },
    })
    const app = express()
    const route = (fn: (req: express.Request, res: express.Response) => Promise<void>) => (req: express.Request, res: express.Response) =>
      void fn(req, res).catch((error: unknown) => {
        log(`${spec.name} seller failed: ${messageOf(error)}`)
        if (!res.headersSent) res.status(502).end()
      })
    app.get(path, route(handler))
    app.get(`${path}/key`, route(handler.key))
    const server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
      s.once('error', reject)
    })
    // The answer carries a memo on Arc, paid by the seller, as in the dispute try.
    const linksFor = async (nonce: Hex, claimId: Hex) => {
      const paid = handler.paidFor(nonce)
      return paid ? linksOf(paid, claimId, client) : null
    }
    // The lookout reads its starting block before the payment, so a claim is always after it.
    const watcher = createSellerWatcher({ client, sellerKey: keys.seller, keyFor: handler.keyFor, mode: 'answer', linksFor, log })
    await watcher.tick()
    const stop = watcher.start(options.watchMs ?? 1000)
    const { port } = server.address() as AddressInfo
    return {
      url: `http://127.0.0.1:${port}${path}`,
      async close() {
        stop()
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      },
    }
  }

  /** Reads the chain until the key is there, the deadline has passed, or the wait is over. */
  async function waitForKey(claim: { claimId: Hex; deadline: bigint; fromBlock: bigint }): Promise<{ key: Hex; transactionHash?: Hex } | null> {
    const until = Date.now() + (options.keyWaitMs ?? KEY_WAIT_MS)
    while (Date.now() < until) {
      try {
        const found = await sealed.readKey(claim.claimId, claim.fromBlock)
        if (found) return found
        if ((await sealed.chainTime()) >= claim.deadline) return null
      } catch {
        // A failed read is read again.
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000))
    }
    return null
  }

  /** The answer's ClaimGasRepaid, read once. A failed read gives no line rather than a guess. */
  async function claimGasLine(claim: { claimId: Hex; fromBlock: bigint }): Promise<string[]> {
    const repaid = sealed.claimGasRepaid ? await sealed.claimGasRepaid(claim.claimId, claim.fromBlock).catch(() => null) : null
    if (!repaid || repaid.amount <= 0n) return []
    const amount = `${formatUsdc(repaid.amount)} USDC`
    return [detail(repaid.sent ? `Claim gas repaid by the seller: ${amount}.` : `Claim gas repaid by the seller as a credit on Arc: ${amount}.`)]
  }

  /**
   * Pays once from the hold, opens the sealed answer with the key, and asks Arc to step in when the key does not come.
   * `lineDropped` is the person trying that on purpose: the seller keeps the key off the connection, so it has to come through Arc.
   */
  async function buy(cap: bigint, { lineDropped = false }: { lineDropped?: boolean } = {}): Promise<OwnPurchase> {
    const host = await openSeller(lineDropped ? () => false : (options.handsOverKey ?? (() => true)))
    try {
      const challenge = await preparePayment({ holdKey: keys.hold, holdAvailable: options.holdAvailable }, { url: host.url, method: 'GET' }, cap)
      if (challenge.kind !== 'priced') throw new Error(`${spec.name} answered without a price`)
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
      if (opened?.matches) {
        return { ...base, data: answerOf(opened.text), body: opened.text, lines: [answerChecked(payment.amount), detail(DELIVERED_SEALED), detail(KEY_CHECKED)] }
      }

      if (!(await sealed.coverageFor(seller, payment.amount).catch(() => false))) return { ...base, data: NO_KEY, body: '', lines: [] }
      let claim: Awaited<ReturnType<SealedPorts['claim']>>
      try {
        // The seller answers a claim from its own wallet, so it gets what that costs first.
        await client.ensureGas(keys.buyer, seller, ANSWER_GAS).catch((error: unknown) => log(`${spec.name} seller gas failed: ${messageOf(error)}`))
        claim = await sealed.claim(box, payment)
      } catch (error) {
        log(`${spec.name} claim failed: ${messageOf(error)}`)
        return { ...base, data: NO_KEY, body: '', lines: [] }
      }
      const found = await waitForKey(claim)
      const fromChain = found ? openBox(box, found.key) : null
      if (fromChain?.matches && lineDropped) {
        return {
          ...base,
          data: answerOf(fromChain.text),
          body: fromChain.text,
          lines: [
            LINE_DROPPED_ANSWERED,
            detail(DELIVERED_FROM_ARC),
            detail(`Claim ${claim.claimId} answered on SealedDelivery. ${KEY_CHECKED}`),
            ...(claim.transactionHash ? [detail(`Claim transaction: ${claim.transactionHash}.`)] : []),
            ...(found?.transactionHash ? [detail(`Answer transaction: ${found.transactionHash}.`)] : []),
            ...(await claimGasLine(claim)),
          ],
        }
      }
      if (fromChain?.matches) {
        return {
          ...base,
          data: answerOf(fromChain.text),
          body: fromChain.text,
          lines: [answerChecked(payment.amount), detail(DELIVERED_FROM_ARC), detail(`Claim ${claim.claimId} answered on SealedDelivery. ${KEY_CHECKED}`)],
        }
      }
      return { ...base, data: CLAIM_OPEN, body: '', lines: [detail(`Claim ${claim.claimId} is open on SealedDelivery ${options.sealedAddress}.`)] }
    } finally {
      await host.close()
    }
  }

  return { candidate, ...(spec.summary ? { summary: spec.summary } : {}), buy }
}

export type OwnSealedSeller = ReturnType<typeof createOwnSealedSeller>

export function createPaymentCheck(options: PaymentCheckOptions): OwnSealedSeller {
  const { lastPayment, sellerNames } = options
  return createOwnSealedSeller(
    PAYMENT_CHECK,
    (payment, seller) => (lastPayment ? lastPayment(payment.from) : lastPaymentFromCircle(payment.from, fetch, seller, sellerNames)),
    options,
  )
}

export type PaymentCheck = OwnSealedSeller
