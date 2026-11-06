// Vercel Node function: /api/try-job is "Ask the agent" on the public page.
// POST {"step":"plan"} ranks the Arc catalog for the job; POST {"step":"approve"} pays the pick once
// from a fixed test wallet; GET ?transfer=<id> says whether that payment has settled on Arc.
import { createTryJobHandler } from '../server/tryJob'
import type { TryJob } from '../server/tryJob'
import { tryJobFromEnv } from '../server/tryJobWire'

let service: TryJob | null | undefined
const handle = createTryJobHandler(() => {
  if (service === undefined) service = tryJobFromEnv()
  return service
})

export function POST(request: Request): Promise<Response> {
  return handle(request)
}

export function GET(request: Request): Promise<Response> {
  return handle(request)
}
