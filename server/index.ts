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
import { loadKeys, loadSealedSellerKeys } from './keys'
import { createHoldPorts } from './ports'
import { createJobPorts } from './jobPorts'
import { createJobService, JobError } from './jobs'
import { createReceiptStore } from './receiptStore'
import { readOnePayment } from './circleRecord'
import { createDemoService, DemoError, SELLER_C_EXTRA_HOLD } from './demo'
import type { DemoAction, DemoKind } from './demo'
import { createDemoPorts } from './demoPorts'
import { createSeller, DEMO_PRICE, SELLER_C_NAME } from './sellers'
import { ARC_NET, createSealedDelivery, createSealedPorts, createSealedScene, parseSealedAddress } from './sealedDelivery'
import { createArkivSink, createArkivWire, createScrubber, createSellerCheck, parseSellerTtl } from './arkiv'
import type { Plan } from './planner'
import type { Hex } from 'viem'
import { mountWorld } from './worldRoutes'

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

const localReceipts = createReceiptStore(DATA_DIR)

// With no writer key the app runs on the local store alone, exactly as before.
const ARKIV_KEY = /^0x[0-9a-fA-F]{64}$/.test(process.env.ARKIV_WRITER_KEY ?? '')
  ? (process.env.ARKIV_WRITER_KEY as Hex)
  : null
const arkivLog = (message: string) => console.error(message)
const arkivScrub = createScrubber([process.env.ARKIV_ACCESS_KEY ?? '', process.env.ARKIV_WRITER_KEY ?? ''])
const arkiv = ARKIV_KEY ? createArkivWire({ writerKey: ARKIV_KEY, accessKey: process.env.ARKIV_ACCESS_KEY ?? '' }) : null
const arkivSink = arkiv
  ? createArkivSink({
      wire: arkiv.wire,
      store: localReceipts,
      sellerTtlSeconds: parseSellerTtl(process.env.SELLER_TTL_SECONDS),
      log: arkivLog,
      scrub: arkivScrub,
    })
  : null
const receiptStore = arkivSink?.store ?? localReceipts

const sellerCPlan: Plan = {
  kind: 'lookup',
  sellerName: SELLER_C_NAME,
  summary: 'Takes care of this job for you.',
  amount: DEMO_PRICE,
  request: { url: `http://127.0.0.1:${PORT}/sellers/c`, method: 'GET' },
}

const jobs = createJobService(
  createJobPorts({ network: `eip155:${ARC_TESTNET_CHAIN_ID}`, holdKey: keys.hold, holdClient }),
  receiptStore,
  undefined,
  arkiv ? { sellerCheck: createSellerCheck(arkiv.wire, arkivLog, arkivScrub), sellerCPlan } : {},
)

// The demo sellers. Each has its own key, and the hold key is never one of them.
const sellerAddress = {
  a: privateKeyToAccount(keys.sellerA).address,
  b: privateKeyToAccount(keys.sellerB).address,
  c: privateKeyToAccount(keys.sellerC).address,
}
const facilitator = new BatchFacilitatorClient({ url: new URL(ARC_GATEWAY_API).origin })
// The switch: close the connection after settling and before the first response. On for the demo.
const DROP_AFTER_SETTLE = process.env.SELLER_DROP_RESPONSE !== 'off'

// With a contract address the same switch moves to the key request. Without one nothing changes.
const sealedAddress = parseSealedAddress(process.env.SEALED_DELIVERY_ADDRESS)
// SEALED_RPC_URL points the contract calls at another node, for a local run.
const sealedClient = sealedAddress
  ? createSealedDelivery({ address: sealedAddress, net: { ...ARC_NET, rpcUrl: process.env.SEALED_RPC_URL ?? ARC_NET.rpcUrl } })
  : null
const sealedKeys = sealedClient ? loadSealedSellerKeys() : null
const sealedScene = sealedClient && sealedKeys
  ? createSealedScene({
      client: sealedClient,
      keys: { a: keys.sellerA, d: sealedKeys.sellerD, e: sealedKeys.sellerE, f: sealedKeys.sellerF },
      facilitator,
      dropKey: () => DROP_AFTER_SETTLE,
      log: (message) => console.error(message),
    })
  : null

const sellerA = createSeller({
  name: 'Seller A',
  payTo: sellerAddress.a,
  declaresRecovery: true,
  facilitator,
  confirmCharged: async (nonce, payer) =>
    (await readOnePayment(nonce, { seller: sellerAddress.a, payer, amount: DEMO_PRICE.toString() })).ok,
  dropAfterSettle: () => !sealedScene && DROP_AFTER_SETTLE,
  ...(sealedScene ? { sealing: sealedScene.sellerASealing } : {}),
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

// Seller C exists only for the expiry scene. It always answers, so only the delivery check stops it.
const sellerC = createSeller({
  name: SELLER_C_NAME,
  payTo: sellerAddress.c,
  declaresRecovery: false,
  facilitator,
  confirmCharged: () => Promise.resolve(false),
  dropAfterSettle: () => false,
})

const demoPorts = {
  ...createDemoPorts({ holdKey: keys.hold, holdClient, buyerClient }),
  ...(sealedClient && sealedScene
    ? { sealed: createSealedPorts({ client: sealedClient, holdKey: keys.hold, buyerKey: keys.buyer, rejected: sealedScene.rejected }) }
    : {}),
}

const demos = createDemoService(
  demoPorts,
  {
    a: { name: 'Seller A', url: `http://127.0.0.1:${PORT}/sellers/a`, address: sellerAddress.a },
    b: { name: 'Seller B', url: `http://127.0.0.1:${PORT}/sellers/b`, address: sellerAddress.b },
    ...(sealedKeys
      ? {
          d: { name: 'Seller D', url: `http://127.0.0.1:${PORT}/sellers/d`, address: privateKeyToAccount(sealedKeys.sellerD).address },
          e: { name: 'Seller E', url: `http://127.0.0.1:${PORT}/sellers/e`, address: privateKeyToAccount(sealedKeys.sellerE).address },
          f: { name: 'Seller F', url: `http://127.0.0.1:${PORT}/sellers/f`, address: privateKeyToAccount(sealedKeys.sellerF).address },
        }
      : {}),
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

// With the WORLD_* variables set, this takes over the hold route. Without them nothing changes.
mountWorld(app, { env: process.env, dataDir: DATA_DIR, createHold: (amount) => holds.start(amount) })

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

// The address only. The key never leaves the backend. The dev proxy strips /api, so both spellings answer.
app.get(['/writer', '/api/writer'], (_req, res) => {
  res.json({ address: arkiv?.writer ?? null })
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
app.get('/sellers/c', sellerRoute(sellerC))
if (sealedScene) {
  app.get('/sellers/a/key', sellerRoute(sellerA.key))
  app.get('/sellers/d', sellerRoute(sealedScene.sellerD))
  app.get('/sellers/d/key', sellerRoute(sealedScene.sellerD.key))
  app.get('/sellers/e', sellerRoute(sealedScene.sellerE))
  app.get('/sellers/e/key', sellerRoute(sealedScene.sellerE.key))
  app.get('/sellers/f', sellerRoute(sealedScene.sellerF))
  app.get('/sellers/f/key', sellerRoute(sealedScene.sellerF.key))
  for (const watcher of sealedScene.watchers(sellerA.keyFor)) watcher.start()
}

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
  const sealedOnly = seller === 'd' || seller === 'e' || seller === 'f'
  if (seller !== 'a' && seller !== 'b' && !(sealedOnly && sealedScene)) {
    res.status(400).json({ error: 'Pick Seller A or Seller B.' })
    return
  }
  startDemo(seller, res)
})

// Which sellers the screen may offer.
app.get('/demo/options', (_req, res) => {
  res.json({ sealed: sealedScene !== null })
})

// The buttons on a stopped run. Anyone may send finalize once the deadline has passed.
const demoActions: DemoAction[] = ['finalize', 'prove', 'withdraw']
for (const action of demoActions) {
  app.post(`/demo/runs/:id/${action}`, async (req, res) => {
    try {
      res.json(await demos.act(req.params.id, action))
    } catch (error) {
      res.status(error instanceof DemoError && error.code === 'UNAVAILABLE' ? 409 : 502).json({
        error: error instanceof Error ? error.message : 'The demo could not finish. Please try again.',
      })
    }
  })
}

// Demo only: shows what signing a fresh payment would cost. vet402 does not do this.
app.post('/demo/compare', (_req, res) => startDemo('compare', res))

// Demo only: the expiry scene. The hold grows first, then the normal flow asks for approval.
app.post('/demo/seller-c', async (_req, res) => {
  if (!arkiv) {
    res.status(404).json({ error: 'This demo is not available.' })
    return
  }
  try {
    await demoPorts.growHold(SELLER_C_EXTRA_HOLD)
    res.json(await jobs.planSellerScene())
  } catch (error) {
    if (error instanceof DemoError) {
      res.status(409).json({ error: error.message })
      return
    }
    sendJobError(res, error)
  }
})

app.get('/demo/runs/:id', (req, res) => {
  const run = demos.get(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'Unknown run.' })
    return
  }
  res.json(run)
})

// The receipts screen does not call the backend, so settlement is watched from here while Arkiv is on.
if (arkivSink) {
  const ARKIV_SWEEP_MS = 15_000
  setInterval(() => {
    void jobs
      .listReceipts(true)
      .catch((error: unknown) => arkivLog(`receipt refresh failed: ${arkivScrub(error)}`))
      .finally(() => arkivSink.sweep())
  }, ARKIV_SWEEP_MS).unref()
}

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
