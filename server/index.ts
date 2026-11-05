import express from 'express'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { requireChain } from '../src/onchain-facts'
import { formatUsdc } from '../src/onchain-money'
import { loadKeys } from './keys'

const ARC_TESTNET_CHAIN_ID = 5042002
const RPC_URL = requireChain(ARC_TESTNET_CHAIN_ID).rpcUrls[0]
const PORT = Number(process.env.PORT ?? 3001)

const keys = loadKeys()

const buyerClient = new GatewayClient({ chain: 'arcTestnet', privateKey: keys.buyer, rpcUrl: RPC_URL })
const holdClient = new GatewayClient({ chain: 'arcTestnet', privateKey: keys.hold, rpcUrl: RPC_URL })

const app = express()
app.use(express.json())

// Amounts only. Keys and addresses never leave the backend.
app.get('/balances', async (_req, res) => {
  try {
    const [buyer, hold] = await Promise.all([buyerClient.getBalances(), holdClient.getBalances()])
    // The agent's budget is everything its wallet holds, in the wallet and in Gateway.
    res.json({
      balance: formatUsdc(buyer.wallet.balance),
      agentBudget: formatUsdc(hold.wallet.balance + hold.gateway.total),
    })
  } catch (error) {
    console.error('balances failed:', error instanceof Error ? error.message : error)
    res.status(502).json({ error: 'Could not load balances' })
  }
})

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
