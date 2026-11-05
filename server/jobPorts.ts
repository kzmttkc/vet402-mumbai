import { GatewayClient } from '@circle-fin/x402-batching/client'
import type { Hex } from 'viem'
import { fetchCandidates } from './discovery'
import type { Candidate } from './discovery'
import type { JobPorts } from './jobs'

const CANDIDATE_CACHE_MS = 5 * 60 * 1000

interface Options {
  chainId: number
  rpcUrl: string
  /** The hold key. It is the agent's only spending wallet. */
  holdKey: Hex
  holdClient: GatewayClient
}

export function createJobPorts({ chainId, rpcUrl, holdKey, holdClient }: Options): JobPorts {
  const network = `eip155:${chainId}`
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

    async pay(request, cap) {
      // A fresh client per payment keeps each approval's cap separate. It is always the hold key.
      const payer = new GatewayClient({ chain: 'arcTestnet', privateKey: holdKey, rpcUrl })
      payer.onBeforePaymentCreation(async ({ selectedRequirements }) => {
        if (selectedRequirements.network !== network) return { abort: true, reason: 'wrong network' }
        if (BigInt(selectedRequirements.amount) > cap) return { abort: true, reason: 'price is above the approved amount' }
      })

      const result = await payer.pay(request.url, { method: request.method, body: request.body })
      return { data: result.data, paid: result.amount }
    },
  }
}
