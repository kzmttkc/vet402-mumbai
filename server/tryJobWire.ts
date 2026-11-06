import { createHash } from 'node:crypto'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_CAIP2, ARC_GATEWAY_API } from '../src/existing/arc-gateway'
import { createArkivReadWire, createScrubber, createSellerCheck } from './arkiv'
import type { SellerCheck } from './arkiv'
import { createJobPorts } from './jobPorts'
import type { TransferInfo } from './jobs'
import { TRANSFER_STATUSES } from './receiptStore'
import type { TransferStatus } from './receiptStore'
import { createPaymentCheck } from './paymentCheckSeller'
import type { PaymentCheck } from './paymentCheckSeller'
import { createSealedDelivery, createSealedPorts, parseSealedAddress } from './sealedDelivery'
import { createTryJob, parseJobDailyLimit } from './tryJob'
import type { TryJob, TryJobPorts } from './tryJob'

const RPC_URL = 'https://rpc.testnet.arc.network'
const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '')

type Env = Record<string, string | undefined>

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * The writer whose entities the public agent trusts: ARKIV_WRITER_ADDRESS, or the address of
 * ARKIV_WRITER_KEY when the deploy holds it. Null when neither is set.
 */
export function arkivWriterFromEnv(env: Env): Address | null {
  if (isKey(env.ARKIV_WRITER_KEY)) return privateKeyToAccount(env.ARKIV_WRITER_KEY).address
  return ADDRESS.test(env.ARKIV_WRITER_ADDRESS ?? '') ? (env.ARKIV_WRITER_ADDRESS as Address) : null
}

/**
 * The delivery check the local app runs, for reading only: the seller's record and Arc's rulings
 * against the address its listing names, filtered on vet402's writer. No key is needed. Null
 * without a writer address, and the agent then picks on words and price alone, as before.
 */
export function readOnlySellerCheck(env: Env, log: (message: string) => void = (m) => console.error(m)): SellerCheck | null {
  const writer = arkivWriterFromEnv(env)
  if (!writer) return null
  const accessKey = env.ARKIV_ACCESS_KEY ?? ''
  return createSellerCheck(createArkivReadWire({ writer, accessKey }), log, createScrubber([accessKey]))
}

const toInfo = (t: { id: string; status: string; txHash?: unknown }): TransferInfo => ({
  id: t.id,
  status: TRANSFER_STATUSES.includes(t.status as TransferStatus) ? (t.status as TransferStatus) : 'received',
  txHash: typeof t.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t.txHash) ? t.txHash : null,
})

/** The key that signs plan ids. Taken from the wallet key, so there is no second secret to manage. */
export const planSecret = (holdKey: Hex) => createHash('sha256').update('vet402 try-job plan ids v1\n').update(holdKey).digest()

/**
 * vet402 Payment Check, from the dispute try's seller and buyer keys: the seller already has a deposit
 * on SealedDelivery, and the buyer pays for gas. Null when either is missing, or when any two of the
 * three wallets are the same, and the agent then ranks the catalog alone. The keys are never logged.
 */
export function paymentCheckFromEnv(
  env: Env,
  { sealedAddress, holdKey, holdAvailable }: { sealedAddress: Address; holdKey: Hex; holdAvailable: () => Promise<bigint> },
): PaymentCheck | null {
  const sellerKey = env.TRY_SELLER_KEY
  const buyerKey = env.TRY_BUYER_KEY
  if (!isKey(sellerKey) || !isKey(buyerKey)) return null
  // The hold is never a seller, and the seller never pays for its own gas from the hold.
  const addresses = [holdKey, sellerKey, buyerKey].map((key) => privateKeyToAccount(key).address)
  if (new Set(addresses).size !== addresses.length) return null
  const client = createSealedDelivery({ address: sealedAddress })
  return createPaymentCheck({
    client,
    sealed: createSealedPorts({ client, holdKey, buyerKey, rejected: new Set() }),
    sealedAddress,
    keys: { hold: holdKey, seller: sellerKey, buyer: buyerKey },
    facilitator: new BatchFacilitatorClient({ url: new URL(ARC_GATEWAY_API).origin }),
    holdAvailable,
  })
}

/**
 * The public agent, from environment variables only. Null when the key is missing, or when it is the
 * same wallet as the dispute try, and the page then says the agent is resting. The key is read here
 * and passed on, never logged.
 */
export function tryJobFromEnv(env: Env = process.env): TryJob | null {
  const holdKey = env.TRY_JOB_HOLD_KEY
  if (!isKey(holdKey)) return null
  // Its own wallet: the dispute try counts its payments by wallet, and the two must not share a balance.
  if (isKey(env.TRY_HOLD_KEY) && env.TRY_HOLD_KEY.toLowerCase() === holdKey.toLowerCase()) return null

  const holdClient = new GatewayClient({ chain: 'arcTestnet', privateKey: holdKey, rpcUrl: RPC_URL })
  const hold = privateKeyToAccount(holdKey).address.toLowerCase()
  const jobPorts = createJobPorts({ network: ARC_CAIP2, holdKey, holdClient })

  // A seller that seals can be checked for deposit cover on the contract the dispute try uses.
  const sealedAddress = parseSealedAddress(env.SEALED_DELIVERY_ADDRESS)
  const sealed = sealedAddress ? createSealedDelivery({ address: sealedAddress }) : null

  const sellerCheck = readOnlySellerCheck(env)
  const ownSeller = sealedAddress ? paymentCheckFromEnv(env, { sealedAddress, holdKey, holdAvailable: () => jobPorts.holdAvailable() }) : null
  const ports: TryJobPorts = {
    ...(sellerCheck ? { sellerCheck } : {}),
    ...(ownSeller ? { ownSeller } : {}),
    candidates: () => jobPorts.candidates(),
    latestReceipt: () => jobPorts.latestReceipt(),
    holdAvailable: () => jobPorts.holdAvailable(),
    pay: (request, cap) => jobPorts.pay(request, cap),
    findTransfer: (nonce, attempts) => jobPorts.findTransfer(nonce, attempts),

    async ownTransfer(id) {
      const transfer = await holdClient.getTransferById(id)
      if (String(transfer.fromAddress ?? '').toLowerCase() !== hold) return null
      return toInfo(transfer)
    },

    async recentPayments() {
      const { transfers } = await holdClient.searchTransfers({ from: holdClient.address, pageSize: 100 })
      return transfers.flatMap((t) => {
        const at = Date.parse(String(t.createdAt ?? ''))
        return Number.isFinite(at) ? [at] : []
      })
    },

    ...(sealed && sealedAddress
      ? {
          coverage: async (candidate) => {
            if (candidate.sealedBy?.toLowerCase() !== sealedAddress.toLowerCase() || !candidate.payTo) return null
            return sealed.coverageFor(candidate.payTo as Address, candidate.amount)
          },
        }
      : {}),
  }

  return createTryJob(ports, { secret: planSecret(holdKey), dailyLimit: parseJobDailyLimit(env.TRY_JOB_DAILY_LIMIT) })
}
