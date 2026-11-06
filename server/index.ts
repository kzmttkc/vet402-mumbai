import path from 'node:path'
import express from 'express'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_GATEWAY_API } from '../src/existing/arc-gateway'
import { AmountError, formatUsdc, parseUsdc } from '../src/onchain-money'
import { createHoldService, HoldError } from './hold'
import { createHoldStore } from './holdStore'
import { loadKeys, loadSealedSellerKeys } from './keys'
import { createHoldPorts } from './ports'
import { createJobPorts } from './jobPorts'
import { createJobService, JobError } from './jobs'
import { createReceiptStore } from './receiptStore'
import { readOnePayment } from './circleRecord'
import { createDemoService, DemoError, fromApprovedHold, SELLER_C_EXTRA_HOLD } from './demo'
import type { DemoAction, DemoKind } from './demo'
import { createDemoPorts } from './demoPorts'
import { createSeller, DEMO_PRICE, SELLER_C_NAME } from './sellers'
import { ARC_NET, createSealedDelivery, createSealedPorts, createSealedScene, parseSealedAddress } from './sealedDelivery'
import { createArkivSink, createArkivWire, createScrubber, createSellerCheck, parseSellerTtl, payToByName, verdictToArkiv } from './arkiv'
import { createEvidenceUploader } from './swarm'
import { createSwarmWire, SWARM_GATEWAY } from '../src/lib/swarmBox'
import type { Plan } from './planner'
import type { Hex } from 'viem'
import { gasFromBudget } from './world'
import { createWorld, refuseCrossSite } from './worldRoutes'

const ARC_TESTNET_CHAIN_ID = 5042002
// The other public node: the balance reads below share a rate limit with the contract reads.
const RPC_URL = 'https://rpc.testnet.arc.network'
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

// With the WORLD_* variables set, the approval takes over the hold. Without them nothing changes.
const world = createWorld({ env: process.env, dataDir: DATA_DIR, createHold: (amount) => holds.start(amount) })
// In production an approval is the only way money reaches the hold wallet. The demo scenes spend from the approved
// hold, and gas for the hold wallet's contract calls is taken from the approved budget. Staging keeps the filmed flow.
const approvalOnly = world?.environment === 'production' ? world.service : null

// The demo sellers. Each has its own key, and the hold key is never one of them.
const sellerAddress = {
  a: privateKeyToAccount(keys.sellerA).address,
  b: privateKeyToAccount(keys.sellerB).address,
  c: privateKeyToAccount(keys.sellerC).address,
}

// With a contract address the same switch moves to the key request. Without one nothing changes.
const sealedAddress = parseSealedAddress(process.env.SEALED_DELIVERY_ADDRESS)
// SEALED_RPC_URL points the contract calls at another node, for a local run.
const sealedClient = sealedAddress
  ? createSealedDelivery({ address: sealedAddress, net: { ...ARC_NET, rpcUrl: process.env.SEALED_RPC_URL ?? ARC_NET.rpcUrl } })
  : null
const sealedKeys = sealedClient ? loadSealedSellerKeys() : null
// The sealed sellers' addresses. Only present with a contract address.
const sealedSellerAddress = sealedKeys
  ? {
      d: privateKeyToAccount(sealedKeys.sellerD).address,
      e: privateKeyToAccount(sealedKeys.sellerE).address,
      f: privateKeyToAccount(sealedKeys.sellerF).address,
    }
  : null

// Our own sellers are found on Arkiv by the address they are paid at. Catalog sellers by name.
const payToOf = payToByName({
  'Seller A': sellerAddress.a,
  'Seller B': sellerAddress.b,
  [SELLER_C_NAME]: sellerAddress.c,
  ...(sealedSellerAddress
    ? { 'Seller D': sealedSellerAddress.d, 'Seller E': sealedSellerAddress.e, 'Seller F': sealedSellerAddress.f }
    : {}),
})

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
      payToOf,
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
  arkiv ? { sellerCheck: createSellerCheck(arkiv.wire, arkivLog, arkivScrub, payToOf), sellerCPlan } : {},
)

const facilitator = new BatchFacilitatorClient({ url: new URL(ARC_GATEWAY_API).origin })
// The switch: close the connection after settling and before the first response. On for the demo.
const DROP_AFTER_SETTLE = process.env.SELLER_DROP_RESPONSE !== 'off'
// A demo run can keep the line up, to show that nothing touches the contract when the key arrives.
let lineStaysUp = false

const sealedScene = sealedClient && sealedKeys
  ? createSealedScene({
      storeDir: path.join(DATA_DIR, 'sellers'),
      client: sealedClient,
      keys: { a: keys.sellerA, d: sealedKeys.sellerD, e: sealedKeys.sellerE, f: sealedKeys.sellerF },
      facilitator,
      dropKey: () => DROP_AFTER_SETTLE && !lineStaysUp,
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
  ...(sealedScene ? { sealing: sealedScene.sellerASealing, storeFile: path.join(DATA_DIR, 'sellers', 'seller-a.json') } : {}),
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

const plainDemoPorts = createDemoPorts({ holdKey: keys.hold, holdClient, buyerClient })
const demoPorts = {
  ...plainDemoPorts,
  ...(approvalOnly ? { growHold: fromApprovedHold(plainDemoPorts) } : {}),
  ...(sealedClient && sealedScene
    ? {
        sealed: createSealedPorts({
          client: approvalOnly ? gasFromBudget(sealedClient, approvalOnly.spend) : sealedClient,
          holdKey: keys.hold,
          buyerKey: keys.buyer,
          rejected: sealedScene.rejected,
        }),
        // SWARM_UPLOAD=off keeps every box off Swarm. SWARM_API_URL points the upload at another Bee API,
        // and SWARM_POSTAGE_BATCH_ID is the batch that Bee API stamps it with.
        ...(process.env.SWARM_UPLOAD === 'off'
          ? {}
          : {
              evidence: createEvidenceUploader({
                swarm: createSwarmWire(process.env.SWARM_API_URL || SWARM_GATEWAY, undefined, process.env.SWARM_POSTAGE_BATCH_ID || undefined),
                contract: sealedClient.address,
                chainId: ARC_NET.chain.id,
              }),
            }),
        // Arc's Silent or Fraud ruling goes to Arkiv, where the delivery check refuses that seller for 7 days.
        ...(arkivSink ? { verdict: verdictToArkiv(arkivSink, sealedClient.address, ARC_NET.chain.id) } : {}),
      }
    : {}),
}

const demos = createDemoService(
  demoPorts,
  {
    a: { name: 'Seller A', url: `http://127.0.0.1:${PORT}/sellers/a`, address: sellerAddress.a },
    b: { name: 'Seller B', url: `http://127.0.0.1:${PORT}/sellers/b`, address: sellerAddress.b },
    ...(sealedSellerAddress
      ? {
          d: { name: 'Seller D', url: `http://127.0.0.1:${PORT}/sellers/d`, address: sealedSellerAddress.d },
          e: { name: 'Seller E', url: `http://127.0.0.1:${PORT}/sellers/e`, address: sealedSellerAddress.e },
          f: { name: 'Seller F', url: `http://127.0.0.1:${PORT}/sellers/f`, address: sealedSellerAddress.f },
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
// No page on another site may start a demo, approve a job or touch the hold.
app.use(refuseCrossSite)

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
if (world) world.mount(app)
else app.get('/world/status', (_req, res) => void res.json({ enabled: false }))

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
  lineStaysUp = (req.body as { lineUp?: unknown }).lineUp === true
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
// In production it pays from the approved hold and adds nothing to it.
app.post('/demo/compare', (_req, res) => startDemo('compare', res))

// Demo only: the expiry scene. On staging the hold grows first. In production the approved hold must already cover it.
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
