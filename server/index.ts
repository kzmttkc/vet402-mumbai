import path from 'node:path'
import express from 'express'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_GATEWAY_API } from '../src/existing/arc-gateway'
import { requireChain } from '../src/onchain-facts'
import { AmountError, formatUsdc, parseUsdc } from '../src/onchain-money'
import { createHoldService, HoldError } from './hold'
import { createHoldStore } from './holdStore'
import { loadKeys } from './keys'
import { createHoldPorts } from './ports'
import { createJobPorts } from './jobPorts'
import { createJobService, JobError } from './jobs'
import { createReceiptStore } from './receiptStore'
import { readOnePayment } from './circleRecord'
import { createDemoService, DemoError } from './demo'
import type { DemoKind } from './demo'
import { createDemoPorts } from './demoPorts'
import { createSeller, DEMO_PRICE } from './sellers'

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

const receiptStore = createReceiptStore(DATA_DIR)

const jobs = createJobService(
  createJobPorts({ network: `eip155:${ARC_TESTNET_CHAIN_ID}`, holdKey: keys.hold, holdClient }),
  receiptStore,
)

// The demo sellers. Each has its own key, and the hold key is never one of them.
const sellerAddress = {
  a: privateKeyToAccount(keys.sellerA).address,
  b: privateKeyToAccount(keys.sellerB).address,
}
const facilitator = new BatchFacilitatorClient({ url: new URL(ARC_GATEWAY_API).origin })
// The switch: close the connection after settling and before the first response. On for the demo.
const DROP_AFTER_SETTLE = process.env.SELLER_DROP_RESPONSE !== 'off'

const sellerA = createSeller({
  name: 'Seller A',
  payTo: sellerAddress.a,
  declaresRecovery: true,
  facilitator,
  confirmCharged: async (nonce, payer) =>
    (await readOnePayment(nonce, { seller: sellerAddress.a, payer, amount: DEMO_PRICE.toString() })).ok,
  dropAfterSettle: () => DROP_AFTER_SETTLE,
})
// Seller B declares nothing: it settles, and it has no way to give the same answer again.
const sellerB = createSeller({
  name: 'Seller B',
  payTo: sellerAddress.b,
  declaresRecovery: false,
  facilitator,
  confirmCharged: () => Promise.resolve(false),
  dropAfterSettle: () => DROP_AFTER_SETTLE,
})

const demos = createDemoService(
  createDemoPorts({ holdKey: keys.hold, holdClient, buyerClient }),
  {
    a: { name: 'Seller A', url: `http://127.0.0.1:${PORT}/sellers/a`, address: sellerAddress.a },
    b: { name: 'Seller B', url: `http://127.0.0.1:${PORT}/sellers/b`, address: sellerAddress.b },
  },
  receiptStore,
)

const MAX_JOB_CHARS = 500

function sendJobError(res: express.Response, error: unknown) {
  if (error instanceof JobError) {
    res.status(error.code === 'BUSY' ? 409 : 400).json({ error: error.message, code: error.code })
    return
  }
  console.error('job failed:', error instanceof Error ? error.message : error)
  res.status(502).json({ error: 'Something went wrong. Please try again.' })
}

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

app.post('/jobs/plan', async (req, res) => {
  const job = (req.body as { job?: unknown })?.job
  if (typeof job !== 'string' || job.length > MAX_JOB_CHARS) {
    res.status(400).json({ error: 'Describe the job in a sentence or two.' })
    return
  }
  try {
    res.json(await jobs.plan(job))
  } catch (error) {
    sendJobError(res, error)
  }
})

// The user approves the amount. The seller was chosen by the agent and is never picked here.
app.post('/jobs/:id/approve', async (req, res) => {
  try {
    res.json(await jobs.approve(req.params.id))
  } catch (error) {
    sendJobError(res, error)
  }
})

app.get('/receipts', async (req, res) => {
  try {
    res.json({ receipts: await jobs.listReceipts(req.query.fresh !== '0') })
  } catch (error) {
    sendJobError(res, error)
  }
})

const sellerRoute = (handler: (req: express.Request, res: express.Response) => Promise<void>) =>
  async (req: express.Request, res: express.Response) => {
    try {
      await handler(req, res)
    } catch (error) {
      console.error('seller failed:', error instanceof Error ? error.message : error)
      if (!res.headersSent) res.status(502).end()
    }
  }
app.get('/sellers/a', sellerRoute(sellerA))
app.get('/sellers/b', sellerRoute(sellerB))

function startDemo(kind: DemoKind, res: express.Response) {
  try {
    res.json(demos.start(kind))
  } catch (error) {
    if (error instanceof DemoError) {
      res.status(409).json({ error: error.message })
      return
    }
    throw error
  }
}

app.post('/demo/run', (req, res) => {
  const seller = (req.body as { seller?: unknown })?.seller
  if (seller !== 'a' && seller !== 'b') {
    res.status(400).json({ error: 'Pick Seller A or Seller B.' })
    return
  }
  startDemo(seller, res)
})

// Demo only: shows what signing a fresh payment would cost. vet402 does not do this.
app.post('/demo/compare', (_req, res) => startDemo('compare', res))

app.get('/demo/runs/:id', (req, res) => {
  const run = demos.get(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'Unknown run.' })
    return
  }
  res.json(run)
})

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
