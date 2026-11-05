import path from 'node:path'
import express from 'express'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { requireChain } from '../src/onchain-facts'
import { AmountError, formatUsdc, parseUsdc } from '../src/onchain-money'
import { createHoldService, HoldError } from './hold'
import { createHoldStore } from './holdStore'
import { loadKeys } from './keys'
import { createHoldPorts } from './ports'

const ARC_TESTNET_CHAIN_ID = 5042002
const RPC_URL = requireChain(ARC_TESTNET_CHAIN_ID).rpcUrls[0]
const PORT = Number(process.env.PORT ?? 3001)
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(import.meta.dirname, '../data')

const keys = loadKeys()

// The buyer funds the hold and never pays sellers. The hold key is the agent's only spending wallet.
const buyerClient = new GatewayClient({ chain: 'arcTestnet', privateKey: keys.buyer, rpcUrl: RPC_URL })
const holdClient = new GatewayClient({ chain: 'arcTestnet', privateKey: keys.hold, rpcUrl: RPC_URL })

const holds = createHoldService(
  createHoldPorts(ARC_TESTNET_CHAIN_ID, buyerClient, holdClient),
  createHoldStore(DATA_DIR),
)

const app = express()
app.use(express.json())

// Amounts only. Keys and addresses never leave the backend.
app.get('/balances', async (_req, res) => {
  try {
    const [buyer, hold] = await Promise.all([buyerClient.getBalances(), holds.status()])
    res.json({ balance: formatUsdc(buyer.wallet.balance), hold })
  } catch (error) {
    console.error('balances failed:', error instanceof Error ? error.message : error)
    res.status(502).json({ error: 'Could not load balances' })
  }
})

app.post('/hold', async (req, res) => {
  let amount: bigint
  try {
    amount = parseUsdc(String((req.body as { amount?: unknown })?.amount ?? ''))
  } catch (error) {
    if (error instanceof AmountError) {
      res.status(400).json({ error: 'Enter a valid amount.' })
      return
    }
    throw error
  }

  try {
    await holds.start(amount)
    res.json({ ok: true })
  } catch (error) {
    if (error instanceof HoldError) {
      const status = error.code === 'BUSY' ? 409 : 400
      res.status(status).json({ error: error.message })
      return
    }
    console.error('hold failed:', error instanceof Error ? error.message : error)
    res.status(502).json({ error: 'The hold could not be set up. Please try again.' })
  }
})

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
