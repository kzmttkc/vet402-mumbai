// The browser's side of "Ask the agent". It sends the job's words, the person's limit, and to approve, the plan's id.
// Nothing here sends an amount, a seller or a payee. The limit can only lower what the server allows.

export const JOB_URL = '/api/try-job'
export const ARC_TX = 'https://explorer.testnet.arc.io/tx/'

const TX_HASH = /^0x[0-9a-fA-F]{64}$/

/** The explorer page for a settled batch, or null when there is no well-formed hash yet. */
export const arcTxUrl = (batchTx: string | null | undefined) => (batchTx && TX_HASH.test(batchTx) ? `${ARC_TX}${batchTx}` : null)

export interface Compared {
  sellerName: string
  listing: string
  amount: string
  note: string
}

export interface AgentPlan {
  id: string
  sellerName: string
  summary: string
  amount: string
  why?: string
  compared: Compared[]
  notices?: string[]
  delivery?: string
  covered: boolean
}

export type PlanAnswer =
  | { ok: true; plan: AgentPlan }
  | { ok: false; message: string; compared: Compared[] }

export interface Paid {
  sellerName: string
  text: string
  paid: string
  transferId: string | null
  status: string | null
  batchTx: string | null
}

export interface Settlement {
  status: string
  batchTx: string | null
}

const COULD_NOT_REACH = 'The agent could not be reached just now. Please try again in a minute.'

async function call<T>(init: RequestInit, url: string, fetchImpl: typeof fetch): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  let res: Response
  try {
    res = await fetchImpl(url, init)
  } catch {
    return { ok: false, message: COULD_NOT_REACH }
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null
  if (!res.ok || !body) return { ok: false, message: typeof body?.error === 'string' ? body.error : COULD_NOT_REACH }
  return { ok: true, value: body }
}

const post = (body: Record<string, string | boolean>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** Asks the agent to pick a seller, within the person's limit. Nothing is paid. */
export async function askAgent(job: string, limit: string, fetchImpl: typeof fetch = fetch): Promise<PlanAnswer> {
  const reply = await call<PlanAnswer>(post({ step: 'plan', job, limit }), JOB_URL, fetchImpl)
  if (!reply.ok) return { ok: false, message: reply.message, compared: [] }
  return reply.value.ok ? reply.value : { ok: false, message: reply.value.message, compared: reply.value.compared ?? [] }
}

/**
 * Approves the plan on the card, with the limit it was planned under. The server plans again from the same words and pays
 * only the same pick. `lineDropped` keeps the key off the connection, so the answer has to come through Arc.
 */
export async function approvePlan(job: string, id: string, limit: string, { lineDropped = false } = {}, fetchImpl: typeof fetch = fetch) {
  return call<Paid>(post({ step: 'approve', job, id, limit, ...(lineDropped ? { lineDropped: true } : {}) }), JOB_URL, fetchImpl)
}

/** Where the payment stands on Arc. */
export async function settlementOf(transferId: string, fetchImpl: typeof fetch = fetch) {
  return call<Settlement>({ method: 'GET' }, `${JOB_URL}?transfer=${encodeURIComponent(transferId)}`, fetchImpl)
}

/** The line once the answer is in, before Circle's batch lands on Arc. The settlement has its own small line under it. */
export function answerLine(paid: string): string {
  if (Number(paid) === 0) return 'Nothing was charged.'
  return `Paid ${paid} USDC. Answer received.`
}

/** The small line under the receipt while the payment waits for its batch. It turns into the link to Arc when it lands. */
export const SETTLING_LINE = 'Settles in Circle’s Gateway batch on Arc. The link shows up here when it lands.'

/** The receipt line, in plain words. No hashes. The link to Arc sits under it once the payment has settled. */
export function receiptLine(paid: string, settled: boolean): string {
  if (Number(paid) === 0) return 'Nothing was charged.'
  return settled ? `Paid ${paid} USDC.` : `Paid ${paid} USDC. Confirming…`
}
