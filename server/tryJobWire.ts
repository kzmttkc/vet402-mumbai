import { createHash } from 'node:crypto'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_CAIP2 } from '../src/existing/arc-gateway'
import { createJobPorts } from './jobPorts'
import type { TransferInfo } from './jobs'
import { TRANSFER_STATUSES } from './receiptStore'
import type { TransferStatus } from './receiptStore'
import { createSealedDelivery, parseSealedAddress } from './sealedDelivery'
import { createTryJob, parseJobDailyLimit } from './tryJob'
import type { TryJob, TryJobPorts } from './tryJob'

const RPC_URL = 'https://rpc.testnet.arc.network'
const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '')

type Env = Record<string, string | undefined>

const toInfo = (t: { id: string; status: string; txHash?: unknown }): TransferInfo => ({
  id: t.id,
  status: TRANSFER_STATUSES.includes(t.status as TransferStatus) ? (t.status as TransferStatus) : 'received',
  txHash: typeof t.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t.txHash) ? t.txHash : null,
})

/** The key that signs plan ids. Taken from the wallet key, so there is no second secret to manage. */
export const planSecret = (holdKey: Hex) => createHash('sha256').update('vet402 try-job plan ids v1\n').update(holdKey).digest()

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

  const ports: TryJobPorts = {
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
