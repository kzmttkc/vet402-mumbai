import { randomUUID } from 'node:crypto'
import { hashSignal } from '@worldcoin/idkit-core/hashing'
import { signRequest } from '@worldcoin/idkit-core/signing'
import { formatUsdc } from '../src/onchain-money'
import { HoldError } from './hold'
import type { WorldRecord, WorldRequest, WorldRequestKind, WorldRequestState, WorldStore } from './worldStore'

export const NOT_APPROVED = 'Not approved. Nothing was held or paid.'
export const ANOTHER_HOLD = 'Not approved: this approval is for another hold.'
export const WAITING = 'Waiting for approval in World ID.'
export const BUDGET_SET = 'Budget set.'
const SETUP_FAILED = 'The hold could not be set up. Please try again.'

const REQUEST_TTL_SECONDS = 120
const VERIFY_URL = 'https://developer.world.org/api/v4/verify'
const VERIFY_TIMEOUT_MS = 20_000
const ENVIRONMENT = 'staging'
const UINT256_MAX = (1n << 256n) - 1n

export interface WorldConfig {
  appId: string
  rpId: string
  signerKey: string
}

/** Returns null when none of the three is set. One or two of them is a mistake, and it must not turn the approval off quietly. */
export function readWorldConfig(env: Record<string, string | undefined>): WorldConfig | null {
  const names = ['WORLD_APP_ID', 'WORLD_RP_ID', 'WORLD_SIGNER_KEY'] as const
  const missing = names.filter((name) => !env[name])
  if (missing.length === names.length) return null
  if (missing.length > 0) throw new Error(`World ID is half configured. Missing: ${missing.join(', ')}`)
  return { appId: env.WORLD_APP_ID!, rpId: env.WORLD_RP_ID!, signerKey: env.WORLD_SIGNER_KEY! }
}

export interface SignedRequest {
  sig: string
  nonce: string
  createdAt: number
  expiresAt: number
}

export interface VerifyAnswer {
  success: boolean
  environment: unknown
}

/** Everything the approval needs from the outside world. */
export interface WorldPorts {
  /** Signs a fresh request without an action. */
  sign(): SignedRequest
  /** Forwards the IDKit result unchanged to World. */
  verify(result: unknown): Promise<VerifyAnswer>
  /** Creates the hold through the existing hold service. */
  createHold(amount: bigint): Promise<void>
}

export function createWorldPorts(
  config: WorldConfig,
  createHold: (amount: bigint) => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): WorldPorts {
  return {
    sign: () => signRequest({ signingKeyHex: config.signerKey, ttl: REQUEST_TTL_SECONDS }),
    async verify(result) {
      const res = await fetchImpl(`${VERIFY_URL}/${encodeURIComponent(config.rpId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      })
      const body = (await res.json().catch(() => null)) as { success?: unknown; environment?: unknown } | null
      return { success: res.ok && body?.success === true, environment: body?.environment }
    },
    createHold,
  }
}

export class WorldError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'WorldError'
    this.status = status
  }
}

/** What the screen is told about a request. It holds no World ID value. */
export interface WorldRequestView {
  id: string
  kind: WorldRequestKind
  state: WorldRequestState
  message: string
}

export interface WorldStatus {
  enabled: true
  budgetSet: boolean
  hasLastApproval: boolean
  request: WorldRequestView | null
}

/** What the browser passes to IDKit. It is never put on screen. */
export interface IdkitParams {
  app_id: string
  environment: typeof ENVIRONMENT
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string }
  session_id?: string
  signal?: string
}

interface IdkitResult {
  environment?: unknown
  nonce?: unknown
  session_id?: unknown
  responses?: Array<{ signal_hash?: unknown; session_nullifier?: unknown } | null>
}

/** World's values can arrive as hex or decimal. Returns null for anything that is not a 256-bit integer. */
function toUint256(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= UINT256_MAX ? parsed : null
}

const amountOnScreen = (raw: string) => `${formatUsdc(BigInt(raw))} USDC`
const signalFor = (request: Pick<WorldRequest, 'id' | 'amount'>) => `${request.id}:${formatUsdc(BigInt(request.amount))}`
const viewOf = ({ id, kind, state, message }: WorldRequest): WorldRequestView => ({ id, kind, state, message })

interface Options {
  appId: string
  rpId: string
  ports: WorldPorts
  store: WorldStore
  now?: () => number
  ttlMs?: number
}

export function createWorldService({ appId, rpId, ports, store, now = Date.now, ttlMs = REQUEST_TTL_SECONDS * 1000 }: Options) {
  function close(record: WorldRecord, request: WorldRequest, message: string, reason: string): WorldRequestView {
    console.warn(`world: closed ${request.kind} request: ${reason}`)
    request.state = 'closed'
    request.message = message
    store.write(record)
    return viewOf(request)
  }

  /** Reads the record with an overdue request already closed. */
  function current(): WorldRecord {
    const record = store.read()
    const { request } = record
    if (request?.state === 'waiting' && now() >= request.expiresAt) close(record, request, NOT_APPROVED, 'expired')
    return record
  }

  // A hold left half made by a restart cannot finish now. Say so instead of showing it as still running.
  const atStart = store.read()
  if (atStart.request?.state === 'creating') close(atStart, atStart.request, SETUP_FAILED, 'restarted')

  function expireLater(id: string) {
    const timer = setTimeout(() => {
      try {
        if (store.read().request?.id === id) current()
      } catch {
        // The next read refuses the same way. A timer must not take the backend down.
        console.error('world: could not close the request')
      }
    }, ttlMs)
    timer.unref?.()
  }

  function begin(record: WorldRecord, kind: WorldRequestKind, amount: bigint, jobId: string | null) {
    if (record.request?.state === 'creating') throw new WorldError(409, 'A hold is already being set up.')

    const signed = ports.sign()
    const request: WorldRequest = {
      id: `${kind}_${randomUUID()}`,
      kind,
      amount: amount.toString(),
      jobId,
      nonce: signed.nonce,
      expiresAt: now() + ttlMs,
      state: 'waiting',
      message: WAITING,
    }
    // Starting again replaces any earlier waiting request, so the earlier one can never be approved.
    record.request = request
    store.write(record)
    expireLater(request.id)

    const idkit: IdkitParams = {
      app_id: appId,
      environment: ENVIRONMENT,
      rp_context: {
        rp_id: rpId,
        nonce: signed.nonce,
        created_at: signed.createdAt,
        expires_at: signed.expiresAt,
        signature: signed.sig,
      },
    }
    return { request, idkit }
  }

  function startBudget(amount: bigint) {
    const record = current()
    if (record.budget) throw new WorldError(409, NOT_APPROVED)
    const { request, idkit } = begin(record, 'budget', amount, null)
    return { request: viewOf(request), idkit }
  }

  function startHold(amount: bigint) {
    const record = current()
    if (!record.budget || amount > BigInt(record.budget.amount)) throw new WorldError(403, NOT_APPROVED)
    const { sessionId } = record.budget
    const { request, idkit } = begin(record, 'hold', amount, `job_${randomUUID()}`)
    return { request: viewOf(request), idkit: { ...idkit, session_id: sessionId, signal: signalFor(request) } }
  }

  function live(id: string) {
    const record = current()
    const { request } = record
    if (request?.id !== id) throw new WorldError(404, NOT_APPROVED)
    return { record, request }
  }

  /** The World answer is awaited here, so a cancel or the 2 minutes can end the request meanwhile. */
  async function askWorld(result: unknown): Promise<VerifyAnswer> {
    try {
      return await ports.verify(result)
    } catch {
      return { success: false, environment: undefined }
    }
  }

  async function completeBudget(id: string, result: IdkitResult): Promise<WorldRequestView> {
    const answer = await askWorld(result)
    const { record, request } = live(id)
    if (request.state !== 'waiting') return viewOf(request)
    if (record.budget) return close(record, request, NOT_APPROVED, 'budget already saved')
    if (!answer.success) return close(record, request, NOT_APPROVED, 'verify failed')
    if (answer.environment !== ENVIRONMENT) return close(record, request, NOT_APPROVED, 'verify environment')
    if (result.environment !== ENVIRONMENT) return close(record, request, NOT_APPROVED, 'result environment')
    if (result.nonce !== request.nonce) return close(record, request, NOT_APPROVED, 'nonce')
    if (typeof result.session_id !== 'string' || !result.session_id) {
      return close(record, request, NOT_APPROVED, 'no session')
    }

    record.budget = { amount: request.amount, sessionId: result.session_id }
    request.state = 'done'
    request.message = BUDGET_SET
    store.write(record)
    return viewOf(request)
  }

  async function completeHold(id: string, result: IdkitResult): Promise<WorldRequestView> {
    const first = live(id)
    const proof = Array.isArray(result.responses) ? result.responses[0] : null

    // The signal comes before everything else, so a proof made for another hold always gets its own sentence,
    // even when its nonce and nullifier would fail too.
    const signalHash = toUint256(proof?.signal_hash)
    if (signalHash === null) return close(first.record, first.request, NOT_APPROVED, 'no signal')
    if (signalHash !== toUint256(hashSignal(signalFor(first.request)))) {
      return close(first.record, first.request, ANOTHER_HOLD, 'signal')
    }

    const answer = await askWorld(result)
    const { record, request } = live(id)
    if (request.state !== 'waiting') return viewOf(request)
    if (!answer.success) return close(record, request, NOT_APPROVED, 'verify failed')
    if (answer.environment !== ENVIRONMENT) return close(record, request, NOT_APPROVED, 'verify environment')
    if (result.environment !== ENVIRONMENT) return close(record, request, NOT_APPROVED, 'result environment')
    if (result.nonce !== request.nonce) return close(record, request, NOT_APPROVED, 'nonce')
    // World accepts a changed tail of the session id and echoes it back. Only the whole saved string counts.
    if (!record.budget || result.session_id !== record.budget.sessionId) {
      return close(record, request, NOT_APPROVED, 'session')
    }
    const raw = proof?.session_nullifier
    const nullifier = toUint256(Array.isArray(raw) ? (raw as unknown[])[0] : undefined)
    if (nullifier === null) return close(record, request, NOT_APPROVED, 'no nullifier')
    const key = nullifier.toString(16)
    if (record.nullifiers.includes(key)) return close(record, request, NOT_APPROVED, 'nullifier reused')

    // One write: the nullifier is taken and the request leaves "waiting" together, before any money moves.
    // A crash after this leaves no hold and a spent nullifier, so nothing can be replayed.
    record.nullifiers.push(key)
    record.lastApproval = result
    request.state = 'creating'
    request.message = 'Setting up the hold…'
    store.write(record)

    try {
      await ports.createHold(BigInt(request.amount))
      request.state = 'done'
      request.message = `Held ${amountOnScreen(request.amount)} for this job.`
    } catch (error) {
      console.error('world: hold failed:', error instanceof Error ? error.message : 'unknown')
      request.state = 'closed'
      request.message = error instanceof HoldError ? error.message : SETUP_FAILED
    }
    const latest = store.read()
    latest.request = request
    store.write(latest)
    return viewOf(request)
  }

  async function complete(id: string, result: unknown): Promise<WorldRequestView> {
    const { request } = live(id)
    if (request.state !== 'waiting') return viewOf(request)
    const body = (result && typeof result === 'object' ? result : {}) as IdkitResult
    return request.kind === 'budget' ? completeBudget(id, body) : completeHold(id, body)
  }

  function cancel(id: string): WorldRequestView {
    const { record, request } = live(id)
    if (request.state !== 'waiting') return viewOf(request)
    return close(record, request, NOT_APPROVED, 'cancelled')
  }

  /** Demo only: sends the previous hold's proof for the new hold. */
  async function useLastApproval(id: string): Promise<WorldRequestView> {
    const { record, request } = live(id)
    if (request.state !== 'waiting' || request.kind !== 'hold' || record.lastApproval === null) return viewOf(request)
    return complete(id, record.lastApproval)
  }

  function status(): WorldStatus {
    const record = current()
    return {
      enabled: true,
      budgetSet: record.budget !== null,
      hasLastApproval: record.lastApproval !== null,
      request: record.request ? viewOf(record.request) : null,
    }
  }

  return { startBudget, startHold, complete, cancel, useLastApproval, status }
}
