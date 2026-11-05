import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_GATEWAY_API } from '../src/existing/arc-gateway'
import { formatUsdc, parseUsdc } from '../src/onchain-money'
import { fetchTransfers, readOnePayment } from './circleRecord'
import type { DemoPorts } from './demo'
import { createDemoPorts } from './demoPorts'
import {
  ANSWER_GAS,
  ARC_NET,
  CLAIM_GAS,
  createSealedDelivery,
  createSealedPorts,
  createSealer,
  createSellerWatcher,
  parseSealedAddress,
} from './sealedDelivery'
import type { SealedNet } from './sealedDelivery'
import { createSeller, DEMO_PRICE } from './sellers'
import type { SellerFacilitator } from './sellers'
import { createTryDispute, parseDailyLimit } from './tryDispute'
import type { TryDispute, TryPorts } from './tryDispute'

/** The hold is refilled from the buyer when it falls under this, by this much. */
export const REFILL_BELOW = parseUsdc('0.005')
export const REFILL_AMOUNT = parseUsdc('0.02')

const RPC_URL = 'https://rpc.testnet.arc.network'
const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '')

export interface TryWireOptions {
  sealedAddress: Address
  net?: SealedNet
  keys: { hold: Hex; seller: Hex; buyer: Hex }
  facilitator: SellerFacilitator
  /** The hold's side of the demo: what it can spend and how it signs. The contract side is added here. */
  demo: Omit<DemoPorts, 'sealed'>
  /** Circle's record for one payment, which Seller A asks before it gives a stored answer again. */
  confirmCharged: (nonce: string, payer: string) => Promise<boolean>
  /** When each payment from the hold to the seller was made, in ms. */
  recentPayments: (hold: Address, seller: Address) => Promise<number[]>
  topUpHold?: () => Promise<void>
  /** How often Seller A's lookout reads the chain. */
  watchMs?: number
  log?: (message: string) => void
}

/** Seller A, its lookout and the agent, all in one process. The seller listens on 127.0.0.1 only for the length of one try. */
export function createTryPorts(options: TryWireOptions): TryPorts {
  const { keys, facilitator } = options
  const log = options.log ?? ((message: string) => console.error(message))
  const client = createSealedDelivery({ address: options.sealedAddress, net: options.net ?? ARC_NET })
  const hold = privateKeyToAccount(keys.hold).address
  const seller = privateKeyToAccount(keys.seller).address
  const buyer = privateKeyToAccount(keys.buyer).address

  const sealed = createSealedPorts({ client, holdKey: keys.hold, buyerKey: keys.buyer, rejected: new Set() })

  return {
    contract: options.sealedAddress,
    demo: { ...options.demo, sealed, sealedPollMs: 1000 },
    log,

    async openSeller() {
      // Seller A pays for its own answer. Only the difference is sent, and only when it runs low.
      await client.ensureGas(keys.buyer, seller, ANSWER_GAS)
      const handler = createSeller({
        name: 'Seller A',
        payTo: seller,
        declaresRecovery: true,
        facilitator,
        confirmCharged: options.confirmCharged,
        dropAfterSettle: () => false,
        // The key request always closes, so the key has to come from the chain.
        sealing: { seal: createSealer(client, keys.seller), handsOverKey: () => false },
      })
      const app = express()
      const route = (fn: (req: express.Request, res: express.Response) => Promise<void>) => (req: express.Request, res: express.Response) =>
        void fn(req, res).catch((error: unknown) => {
          log(`try seller failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
          if (!res.headersSent) res.status(502).end()
        })
      app.get('/sellers/a', route(handler))
      app.get('/sellers/a/key', route(handler.key))
      const server = await new Promise<Server>((resolve, reject) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s))
        s.once('error', reject)
      })
      const watcher = createSellerWatcher({ client, sellerKey: keys.seller, keyFor: handler.keyFor, mode: 'answer', log })
      // The lookout reads its starting block before the payment, so the claim is always after it.
      await watcher.tick()
      const stop = watcher.start(options.watchMs ?? 1000)
      const { port } = server.address() as AddressInfo
      return {
        seller: { name: 'Seller A', url: `http://127.0.0.1:${port}/sellers/a`, address: seller },
        async close() {
          stop()
          server.closeAllConnections()
          await new Promise((resolve) => server.close(resolve))
        },
      }
    },

    recentPayments: () => options.recentPayments(hold, seller),

    async ready() {
      const [available, covered, buyerHas, gasNeeded] = await Promise.all([
        options.demo.holdAvailable(),
        client.coverageFor(seller, DEMO_PRICE),
        client.usdcBalance(buyer),
        client.gasCost(CLAIM_GAS + ANSWER_GAS),
      ])
      return available >= DEMO_PRICE && covered && buyerHas >= gasNeeded
    },

    ...(options.topUpHold ? { afterRun: options.topUpHold } : {}),
  }
}

/** Circle's record of every payment from the hold to the seller, as times. Newest first. */
export async function recentPaymentTimes(hold: Address, seller: Address, fetchImpl: typeof fetch = fetch): Promise<number[]> {
  const transfers = await fetchTransfers(`from=${encodeURIComponent(hold)}&to=${encodeURIComponent(seller)}`, fetchImpl)
  return transfers.flatMap((transfer) => {
    const at = Date.parse(String((transfer as { createdAt?: unknown }).createdAt ?? ''))
    return Number.isFinite(at) ? [at] : []
  })
}

type Env = Record<string, string | undefined>

/**
 * The real try, from environment variables only. Null when one is missing, and the page then says the demo is resting.
 * The keys are read here and passed on, never logged.
 */
export function tryDisputeFromEnv(env: Env = process.env): TryDispute | null {
  const sealedAddress = parseSealedAddress(env.SEALED_DELIVERY_ADDRESS)
  const hold = env.TRY_HOLD_KEY
  const sellerKey = env.TRY_SELLER_KEY
  const buyer = env.TRY_BUYER_KEY
  if (!sealedAddress || !isKey(hold) || !isKey(sellerKey) || !isKey(buyer)) return null
  const addresses = [hold, sellerKey, buyer].map((key) => privateKeyToAccount(key).address)
  if (new Set(addresses).size !== addresses.length) return null

  const holdClient = new GatewayClient({ chain: 'arcTestnet', privateKey: hold, rpcUrl: RPC_URL })
  const buyerClient = new GatewayClient({ chain: 'arcTestnet', privateKey: buyer, rpcUrl: RPC_URL })
  const sellerAddress = privateKeyToAccount(sellerKey).address

  const ports = createTryPorts({
    sealedAddress,
    keys: { hold, seller: sellerKey, buyer },
    facilitator: new BatchFacilitatorClient({ url: new URL(ARC_GATEWAY_API).origin }),
    demo: createDemoPorts({ holdKey: hold, holdClient, buyerClient }),
    confirmCharged: async (nonce, payer) =>
      (await readOnePayment(nonce, { seller: sellerAddress, payer, amount: DEMO_PRICE.toString() })).ok,
    recentPayments: (holdAddress, seller) => recentPaymentTimes(holdAddress, seller),
    // The same deposit the hold card uses. It is not awaited until Gateway shows it, so the try ends on time.
    async topUpHold() {
      if ((await holdClient.getBalances()).gateway.available >= REFILL_BELOW) return
      if ((await buyerClient.getBalances()).wallet.balance < REFILL_AMOUNT) return
      await buyerClient.depositFor(formatUsdc(REFILL_AMOUNT), holdClient.address)
    },
  })
  return createTryDispute(ports, { dailyLimit: parseDailyLimit(env.TRY_DAILY_LIMIT) })
}
