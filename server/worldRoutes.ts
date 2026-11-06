import { randomBytes, timingSafeEqual } from 'node:crypto'
import type express from 'express'
import { AmountError, parseUsdc } from '../src/onchain-money'
import { createWorldPorts, createWorldService, NOT_APPROVED, readWorldConfig, WorldError } from './world'
import type { WorldEnvironment, WorldService } from './world'
import { createWorldStore } from './worldStore'

interface Options {
  env: Record<string, string | undefined>
  dataDir: string
  /** The existing hold path. The approval never makes a hold any other way. */
  createHold: (amount: bigint) => Promise<void>
  fetchImpl?: typeof fetch
  /** For tests. The backend makes a fresh one at every start. */
  token?: string
}

export interface WorldSetup {
  environment: WorldEnvironment
  service: WorldService
  /** Adds the World routes and closes the plain hold route. Call it before the existing POST /hold route. */
  mount(app: express.Express): void
}

/** The header every route that changes the approval needs. Only the app's own screen can read its value. */
export const SESSION_HEADER = 'x-vet402-session'
export const SESSION_EXPIRED = 'This screen is out of date. Reload the page.'

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

/**
 * The token is made at start and handed out only to a request the browser marks as coming from the app's own page.
 * Another site cannot read it, and a browser does not let a page set Sec-Fetch-Site, so a page on another site
 * cannot start, approve or cancel anything here.
 */
function sessionGuard(token: string) {
  const expected = Buffer.from(token)
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const sent = req.get(SESSION_HEADER)
    if (!sent) {
      res.status(401).json({ error: SESSION_EXPIRED, code: 'SESSION' })
      return
    }
    const given = Buffer.from(sent)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.status(403).json({ error: SESSION_EXPIRED, code: 'SESSION' })
      return
    }
    next()
  }
}

/**
 * For every route that changes something, World or not: a request the browser marks as sent from another site is
 * refused. A browser does not let a page change this header. A request with no such header did not come from a browser.
 */
export function refuseCrossSite(req: express.Request, res: express.Response, next: express.NextFunction) {
  const site = req.get('sec-fetch-site')
  if (req.method !== 'GET' && req.method !== 'HEAD' && site !== undefined && site !== 'same-origin') {
    res.status(403).json({ error: 'Open this page from the app itself.' })
    return
  }
  next()
}

/** Returns null when the WORLD_* variables are not set. */
export function createWorld({ env, dataDir, createHold, fetchImpl, token }: Options): WorldSetup | null {
  const config = readWorldConfig(env)
  if (!config) return null

  const service = createWorldService({
    appId: config.appId,
    rpId: config.rpId,
    environment: config.environment,
    ports: createWorldPorts(config, createHold, fetchImpl),
    store: createWorldStore(dataDir, config.environment),
  })
  const sessionToken = token ?? randomBytes(32).toString('base64url')

  function mount(app: express.Express) {
    const guarded = sessionGuard(sessionToken)

    // With World ID on, nothing reaches the plain hold route. An approval is the only way in.
    app.post('/hold', (_req, res) => void res.status(403).json({ error: NOT_APPROVED }))

    app.get('/world/session', (req, res) => {
      if (req.get('sec-fetch-site') !== 'same-origin') {
        res.status(403).json({ error: SESSION_EXPIRED, code: 'SESSION' })
        return
      }
      res.set('Cache-Control', 'no-store').json({ token: sessionToken })
    })
    app.get('/world/status', route(() => service.status()))
    app.post('/world/budget', guarded, route((req) => service.startBudget(readAmount(req))))
    app.post('/world/hold', guarded, route((req) => service.startHold(readAmount(req))))
    app.post('/world/requests/:id/complete', guarded, route((req) =>
      service.complete(String(req.params.id), (req.body as { result?: unknown })?.result),
    ))
    app.post('/world/requests/:id/cancel', guarded, route((req) => service.cancel(String(req.params.id))))
    app.post('/world/requests/:id/use-last-approval', guarded, route((req) => service.useLastApproval(String(req.params.id))))
  }

  return { environment: config.environment, service, mount }
}

/** Call this before the existing POST /hold route. Without the WORLD_* variables only the status route is added. */
export function mountWorld(app: express.Express, options: Options): WorldSetup | null {
  const world = createWorld(options)
  if (!world) {
    app.get('/world/status', (_req, res) => void res.json({ enabled: false }))
    return null
  }
  world.mount(app)
  return world
}
