// Runs the try function's handler on its own port, without `vercel dev`, for a check against the real network.
// It reads TRY_HOLD_KEY, TRY_SELLER_KEY, TRY_BUYER_KEY, SEALED_DELIVERY_ADDRESS and TRY_DAILY_LIMIT from the environment.
// Run: PORT=3997 npx bun run scripts/try-dispute-serve.ts   (Vite's dev server sends /api/try-dispute here.)
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createTryHandler } from '../server/tryDispute'
import type { TryDispute } from '../server/tryDispute'
import { tryDisputeFromEnv } from '../server/tryDisputeWire'

const PORT = Number(process.env.PORT ?? 3997)

let service: TryDispute | null | undefined
const handle = createTryHandler(() => {
  if (service === undefined) service = tryDisputeFromEnv()
  return service
})

/** The request as the function sees it: method, path and headers. The body is never read. */
function toRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(', '))
  }
  // Locally the address is the socket's, as the platform would report it.
  if (!headers.has('x-forwarded-for') && req.socket.remoteAddress) headers.set('x-forwarded-for', req.socket.remoteAddress)
  return new Request(`http://localhost:${PORT}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers })
}

async function send(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  }
  res.end()
}

const server = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  if (path !== '/api/try-dispute') {
    res.writeHead(404).end()
    return
  }
  void handle(toRequest(req))
    .then((response) => send(res, response))
    .catch((error: unknown) => {
      console.error('try-dispute serve failed:', error instanceof Error ? error.message.split('\n')[0] : error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
})
server.requestTimeout = 0
server.listen(PORT, '127.0.0.1', () => console.log(`try-dispute listening on http://127.0.0.1:${PORT}/api/try-dispute`))

const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
