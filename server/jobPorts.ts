import { GatewayClient } from '@circle-fin/x402-batching/client'
import type { Hex } from 'viem'
import { fetchCandidates } from './discovery'
import type { Candidate } from './discovery'
import type { JobPorts, TransferInfo } from './jobs'
import { TRANSFER_STATUSES } from './receiptStore'
import type { TransferStatus } from './receiptStore'
import { payFromHold } from './gatewayPay'

const CANDIDATE_CACHE_MS = 5 * 60 * 1000
const LOOKUP_DELAY_MS = 600

interface PayerOptions {
  /** CAIP-2 network the payment must be on. */
  network: string
  /** The hold key. It is the agent's only spending wallet. */
  holdKey: Hex
}

const toInfo = (t: { id: string; status: string; txHash?: unknown }): TransferInfo => ({
  id: t.id,
  status: TRANSFER_STATUSES.includes(t.status as TransferStatus) ? (t.status as TransferStatus) : 'received',
  txHash: typeof t.txHash === 'string' && t.txHash ? t.txHash : null,
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Options extends PayerOptions {
  holdClient: GatewayClient
}

export function createJobPorts({ network, holdKey, holdClient }: Options): JobPorts {
  let cache: { at: number; items: Candidate[] } | null = null

  return {
    async candidates() {
      if (cache && Date.now() - cache.at < CANDIDATE_CACHE_MS) return cache.items
      const items = await fetchCandidates(network)
      cache = { at: Date.now(), items }
      return items
    },

    async latestReceipt() {
      // The agent's receipts are its Gateway payment rows. The newest one carries the batch transaction.
      const { transfers } = await holdClient.searchTransfers({ from: holdClient.address, pageSize: 50 })
      const newest = [...transfers].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
      if (!newest) return null
      const txHash = newest.txHash
      return { batchTx: typeof txHash === 'string' && txHash ? txHash : null }
    },

    async holdAvailable() {
      return (await holdClient.getBalances()).gateway.available
    },

    pay: (request, cap) =>
      payFromHold(
        { holdKey, holdAvailable: async () => (await holdClient.getBalances()).gateway.available },
        request,
        cap,
      ),

    async findTransfer(nonce, attempts = 1) {
      for (let i = 0; i < attempts; i++) {
        const { transfers } = await holdClient.searchTransfers({ nonce: nonce as Hex })
        const found = transfers[0]
        if (found) return toInfo(found)
        if (i < attempts - 1) await sleep(LOOKUP_DELAY_MS)
      }
      return null
    },

    async fetchTransfer(id) {
      return toInfo(await holdClient.getTransferById(id))
    },
  }
}
