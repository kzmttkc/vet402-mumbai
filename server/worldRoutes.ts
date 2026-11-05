import type express from 'express'
import { AmountError, parseUsdc } from '../src/onchain-money'
import { createWorldPorts, createWorldService, NOT_APPROVED, readWorldConfig, WorldError } from './world'
import { createWorldStore } from './worldStore'

interface Options {
  env: Record<string, string | undefined>
  dataDir: string
  /** The existing hold path. The approval never makes a hold any other way. */
  createHold: (amount: bigint) => Promise<void>
  fetchImpl?: typeof fetch
}

const INVALID_AMOUNT = 'Enter a valid amount.'

function readAmount(req: express.Request): bigint {
  try {
    const amount = parseUsdc(String((req.body as { amount?: unknown })?.amount ?? ''))
    if (amount <= 0n) throw new WorldError(400, INVALID_AMOUNT)
    return amount
  } catch (error) {
    if (error instanceof AmountError) throw new WorldError(400, INVALID_AMOUNT)
    throw error
  }
}

const route =
  (handler: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    try {
      res.json(await handler(req))
    } catch (error) {
      if (error instanceof WorldError) {
        res.status(error.status).json({ error: error.message })
        return
      }
      // The error itself stays out of the log: signing errors can quote their input.
      console.error('world: request failed')
      res.status(502).json({ error: NOT_APPROVED })
    }
  }

/** Call this before the existing POST /hold route. Without the WORLD_* variables only the status route is added. */
export function mountWorld(app: express.Express, { env, dataDir, createHold, fetchImpl }: Options): boolean {
  const config = readWorldConfig(env)
  if (!config) {
    app.get('/world/status', (_req, res) => void res.json({ enabled: false }))
    return false
  }

  const world = createWorldService({
    appId: config.appId,
    rpId: config.rpId,
    ports: createWorldPorts(config, createHold, fetchImpl),
    store: createWorldStore(dataDir),
  })

  // With World ID on, nothing reaches the plain hold route. An approval is the only way in.
  app.post('/hold', (_req, res) => void res.status(403).json({ error: NOT_APPROVED }))

  app.get('/world/status', route(() => world.status()))
  app.post('/world/budget', route((req) => world.startBudget(readAmount(req))))
  app.post('/world/hold', route((req) => world.startHold(readAmount(req))))
  app.post('/world/requests/:id/complete', route((req) =>
    world.complete(String(req.params.id), (req.body as { result?: unknown })?.result),
  ))
  app.post('/world/requests/:id/cancel', route((req) => world.cancel(String(req.params.id))))
  app.post('/world/requests/:id/use-last-approval', route((req) => world.useLastApproval(String(req.params.id))))
  return true
}
