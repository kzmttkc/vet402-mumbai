// Vercel Node function: POST /api/try-dispute runs one sealed dispute on Arc testnet and streams each step.
// Everything happens inside this one call, because nothing kept in memory survives to the next one.
import { createTryHandler } from '../server/tryDispute'
import type { TryDispute } from '../server/tryDispute'
import { tryDisputeFromEnv } from '../server/tryDisputeWire'

let service: TryDispute | null | undefined
const handle = createTryHandler(() => {
  if (service === undefined) service = tryDisputeFromEnv()
  return service
})

export function POST(request: Request): Promise<Response> {
  return handle(request)
}

export function GET(request: Request): Promise<Response> {
  return handle(request)
}
