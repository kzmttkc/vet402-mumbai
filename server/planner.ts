import type { Candidate } from './discovery'

/** The JSON-RPC relay path used to check whether a payment went through. */
export const RELAY_PATH = '/arc-testnet'

export interface PlannedRequest {
  url: string
  method: 'GET' | 'POST'
  body?: Record<string, unknown>
}

export interface Plan {
  kind: 'receipt-check' | 'lookup'
  sellerName: string
  /** One plain sentence about the job. Written by us, never copied from a listing. */
  summary: string
  /** What the agent asks to spend, in atomic USDC units. */
  amount: bigint
  request: PlannedRequest
}

export type PlanFailure = 'EMPTY_JOB' | 'NO_SELLER' | 'NO_PAYMENTS' | 'NOT_SETTLED'

export type PlanOutcome = { ok: true; plan: Plan } | { ok: false; reason: PlanFailure }

/** The newest row of the agent's payment history. `batchTx` is null until the payment is batched onchain. */
export interface LatestReceipt {
  batchTx: string | null
}

const PAYMENT_QUESTION =
  /\b(payments?|paid|pay|receipts?|transactions?|tx|settled?|settlement|confirmed|went through|go through|gone through|did it arrive)\b/i

const TX_HASH = /^0x[0-9a-fA-F]{64}$/

// Words that say nothing about which seller fits.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'whats', 'how', 'can', 'you', 'please', 'need', 'want',
  'get', 'give', 'show', 'tell', 'about', 'from', 'have', 'has', 'was', 'were', 'are', 'did', 'does', 'would',
  'could', 'should', 'into', 'out', 'any', 'all', 'but', 'not', 'there', 'their', 'them', 'then', 'than',
  'find', 'check', 'look', 'make', 'me', 'my', 'our', 'your', 'its', 'job',
])

// Request fields where the job text can go as-is.
const TEXT_FIELDS = ['query', 'q', 'prompt', 'text', 'question', 'message', 'input', 'search', 'topic']

// Written by us so a listing's own words (which can name a network) never reach the screen.
const SUMMARIES: Record<string, string> = {
  SOCIAL_INTELLIGENCE: 'Looks up social data to help with this job.',
  FINANCIAL_ANALYSIS: 'Looks up market data to help with this job.',
  WEB_SEARCH_RESEARCH: 'Searches the web to help with this job.',
  PREDICTION_MARKETS: 'Looks up forecast data to help with this job.',
  CREATIVE: 'Creates something for this job.',
  INFRASTRUCTURE: 'Runs a technical lookup for this job.',
}
const DEFAULT_SUMMARY = 'Takes care of this job for you.'
const RECEIPT_SUMMARY = 'Checks whether your latest payment went through.'

export function isPaymentJob(job: string): boolean {
  return PAYMENT_QUESTION.test(job)
}

/** Resource URLs come from a public catalog, so only plain https hostnames are ever called. */
export function isSafeResource(resource: string): boolean {
  let url: URL
  try {
    url = new URL(resource)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false
  }
  // IP addresses (v4 or v6) are never expected from a real seller.
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return false
  return host.includes('.')
}

const isRelay = (c: Candidate) => c.path.replace(/\/+$/, '') === RELAY_PATH

function tokens(job: string): string[] {
  const words = job.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))]
}

/** Builds the request for a general job, or null when the listing asks for fields we cannot fill. */
function genericRequest(candidate: Candidate, job: string): PlannedRequest | null {
  if (candidate.method === 'GET') return { url: candidate.resource, method: 'GET' }

  const schema = candidate.bodySchema
  const body: Record<string, unknown> = {}
  const textField = TEXT_FIELDS.find((f) => schema?.properties.includes(f))
  if (textField) body[textField] = job

  if (schema && !schema.required.every((field) => field in body)) return null
  return { url: candidate.resource, method: 'POST', body }
}

function receiptPlan(candidate: Candidate, batchTx: string): Plan {
  return {
    kind: 'receipt-check',
    sellerName: candidate.sellerName,
    summary: RECEIPT_SUMMARY,
    amount: candidate.amount,
    request: {
      url: candidate.resource,
      method: 'POST',
      // Exactly one receipt lookup, for the batch transaction of the latest receipt row.
      body: { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [batchTx] },
    },
  }
}

export function planJob(job: string, candidates: Candidate[], latest: LatestReceipt | null): PlanOutcome {
  const text = job.trim()
  if (!text) return { ok: false, reason: 'EMPTY_JOB' }

  const usable = candidates.filter((c) => isSafeResource(c.resource))

  if (isPaymentJob(text)) {
    const relay = usable.filter(isRelay).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0]
    if (relay) {
      if (!latest) return { ok: false, reason: 'NO_PAYMENTS' }
      if (!latest.batchTx || !TX_HASH.test(latest.batchTx)) return { ok: false, reason: 'NOT_SETTLED' }
      return { ok: true, plan: receiptPlan(relay, latest.batchTx) }
    }
  }

  const words = tokens(text)
  let best: { candidate: Candidate; request: PlannedRequest; score: number } | null = null

  for (const candidate of usable) {
    if (isRelay(candidate)) continue
    const score = words.filter((w) => candidate.matchText.includes(w)).length
    if (score === 0) continue

    const request = genericRequest(candidate, text)
    if (!request) continue

    if (!best || score > best.score || (score === best.score && candidate.amount < best.candidate.amount)) {
      best = { candidate, request, score }
    }
  }

  if (!best) return { ok: false, reason: 'NO_SELLER' }

  return {
    ok: true,
    plan: {
      kind: 'lookup',
      sellerName: best.candidate.sellerName,
      summary: SUMMARIES[best.candidate.category] ?? DEFAULT_SUMMARY,
      amount: best.candidate.amount,
      request: best.request,
    },
  }
}
