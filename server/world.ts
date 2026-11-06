import { randomUUID } from 'node:crypto'
import { hashSignal } from '@worldcoin/idkit-core/hashing'
import { signRequest } from '@worldcoin/idkit-core/signing'
import { formatUsdc } from '../src/onchain-money'
import type { Address, Hex } from 'viem'
import { HoldError } from './hold'
import type { WorldBudget, WorldRecord, WorldRequest, WorldRequestKind, WorldRequestState, WorldStore } from './worldStore'

export const NOT_APPROVED = 'Not approved. Nothing was held or paid.'
export const ANOTHER_HOLD = 'Not approved: this approval is for another hold.'
export const OVER_BUDGET = 'Not approved: this is more than the budget has left.'
export const WAITING = 'Waiting for approval in World ID.'
export const BUDGET_SET = 'Budget set.'
const SETUP_FAILED = 'The hold could not be set up. Please try again.'

const REQUEST_TTL_SECONDS = 120
const VERIFY_URL = 'https://developer.world.org/api/v4/verify'
const VERIFY_TIMEOUT_MS = 20_000
const UINT256_MAX = (1n << 256n) - 1n

/** "staging" is the World ID Simulator. "production" is the real World App on a phone. */
export type WorldEnvironment = 'staging' | 'production'
const ENVIRONMENTS: readonly WorldEnvironment[] = ['staging', 'production']

export interface WorldConfig {
  appId: string
  rpId: string
  signerKey: string
  environment: WorldEnvironment
}

/** Returns null when none of the three is set. One or two of them is a mistake, and it must not turn the approval off quietly. */
export function readWorldConfig(env: Record<string, string | undefined>): WorldConfig | null {
  const names = ['WORLD_APP_ID', 'WORLD_RP_ID', 'WORLD_SIGNER_KEY'] as const
  const missing = names.filter((name) => !env[name])
  if (missing.length === names.length) return null
  if (missing.length > 0) throw new Error(`World ID is half configured. Missing: ${missing.join(', ')}`)
  // Unset means the Simulator, as before. A typo must not quietly fall back to the other environment.
  const environment = (env.WORLD_ENVIRONMENT || 'staging') as WorldEnvironment
  if (!ENVIRONMENTS.includes(environment)) throw new Error('WORLD_ENVIRONMENT must be "staging" or "production".')
  return { appId: env.WORLD_APP_ID!, rpId: env.WORLD_RP_ID!, signerKey: env.WORLD_SIGNER_KEY!, environment }
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
  config: Pick<WorldConfig, 'rpId' | 'signerKey'>,
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
  environment: WorldEnvironment
  budgetSet: boolean
  /** What the budget can still approve, in USDC. Null without a budget. */
  budgetLeft: string | null
  hasLastApproval: boolean
  request: WorldRequestView | null
}

/** What the browser passes to IDKit. It is never put on screen. */
export interface IdkitParams {
  app_id: string
  environment: WorldEnvironment
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string }
  session_id?: string
  signal?: string
}

interface IdkitResult {
  protocol_version?: unknown
  environment?: unknown
  nonce?: unknown
  session_id?: unknown
  responses?: Array<{ identifier?: unknown; signal_hash?: unknown; session_nullifier?: unknown } | null>
}

/** The only proof this app asks for. A session proof of World ID 4.0 for Proof of Human. */
const PROTOCOL_VERSION = '4.0'
const CREDENTIAL = 'proof_of_human'

/** IDKit gives the session nullifier as [nullifier, action]. A bare string is taken as the nullifier itself. */
function sessionNullifierOf(raw: unknown): bigint | null {
  return toUint256(Array.isArray(raw) ? (raw as unknown[])[0] : raw)
}

/** World's values can arrive as hex or decimal. Returns null for anything that is not a 256-bit integer. */
function toUint256(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= UINT256_MAX ? parsed : null
}

const amountOnScreen = (raw: string) => `${formatUsdc(BigInt(raw))} USDC`
const holdSignal = (request: Pick<WorldRequest, 'id' | 'amount'>) => `${request.id}:${formatUsdc(BigInt(request.amount))}`
/** The budget proof carries its amount, so the amount saved is the amount the person approved. */
const budgetSignal = (request: Pick<WorldRequest, 'id' | 'amount'>) => `budget:${formatUsdc(BigInt(request.amount))}:${request.id}`
const signalFor = (request: WorldRequest) => (request.kind === 'budget' ? budgetSignal(request) : holdSignal(request))
const viewOf = ({ id, kind, state, message }: WorldRequest): WorldRequestView => ({ id, kind, state, message })

/** Only a budget set with its own proof counts. One saved before that, with no id or nullifier, is treated as unset. */
function budgetOf(record: WorldRecord): WorldBudget | null {
  const budget = record.budget as Partial<WorldBudget> | null
  if (!budget) return null
  const fields = [budget.id, budget.amount, budget.sessionId, budget.used, budget.nullifier]
  return fields.every((field) => typeof field === 'string' && field) ? (budget as WorldBudget) : null
}

const leftOf = (budget: WorldBudget) => BigInt(budget.amount) - BigInt(budget.used)

interface Options {
  appId: string
  rpId: string
  ports: WorldPorts
  store: WorldStore
  /** Both the verify answer and the IDKit result must name this environment. */
  environment?: WorldEnvironment
  now?: () => number
  ttlMs?: number
}

export function createWorldService({
  appId,
  rpId,
  ports,
  store,
  environment = 'staging',
  now = Date.now,
  ttlMs = REQUEST_TTL_SECONDS * 1000,
}: Options) {
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

  function begin(record: WorldRecord, kind: WorldRequestKind, amount: bigint) {
    if (record.request?.state === 'creating') throw new WorldError(409, 'A hold is already being set up.')

    const signed = ports.sign()
    const request: WorldRequest = {
      id: `${kind}_${randomUUID()}`,
      kind,
      amount: amount.toString(),
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
      environment,
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
    const saved = budgetOf(record)
    const { request, idkit } = begin(record, 'budget', amount)
    // The first budget creates the session. A new budget is a proof of that same session, so only the person who set
    // the first one can raise it. The old budget stays as it was until the new proof passes.
    return {
      request: viewOf(request),
      idkit: { ...idkit, ...(saved ? { session_id: saved.sessionId } : {}), signal: budgetSignal(request) },
    }
  }

  function startHold(amount: bigint) {
    const record = current()
    const budget = budgetOf(record)
    if (!budget) throw new WorldError(403, NOT_APPROVED)
    if (amount > leftOf(budget)) throw new WorldError(403, OVER_BUDGET)
    // The hold is the agent's spending limit. Jobs are planned after it and several are paid from one hold.
    const { request, idkit } = begin(record, 'hold', amount)
    return { request: viewOf(request), idkit: { ...idkit, session_id: budget.sessionId, signal: holdSignal(request) } }
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

  /**
   * The checks both steps share. The signal comes before everything else, so a proof made for another request always
   * gets its own sentence, even when its nonce and nullifier would fail too.
   * `commit` runs in the same turn as the last read, with no await between, so two answers for one request cannot
   * both pass on a record that is already out of date.
   */
  async function check<T>(
    id: string,
    result: IdkitResult,
    sessionId: (record: WorldRecord) => string | null,
    commit: (record: WorldRecord, request: WorldRequest, nullifier: string) => T,
  ): Promise<{ ok: true; value: T } | { ok: false; view: WorldRequestView }> {
    const first = live(id)
    const proof = Array.isArray(result.responses) ? result.responses[0] : null
    const wrongSignal = first.request.kind === 'hold' ? ANOTHER_HOLD : NOT_APPROVED

    const signalHash = toUint256(proof?.signal_hash)
    if (signalHash === null) return { ok: false, view: close(first.record, first.request, NOT_APPROVED, 'no signal') }
    if (signalHash !== toUint256(hashSignal(signalFor(first.request)))) {
      return { ok: false, view: close(first.record, first.request, wrongSignal, 'signal') }
    }

    const answer = await askWorld(result)
    const { record, request } = live(id)
    const fail = (reason: string) => ({ ok: false as const, view: close(record, request, NOT_APPROVED, reason) })
    if (request.state !== 'waiting') return { ok: false, view: viewOf(request) }
    if (!answer.success) return fail('verify failed')
    if (answer.environment !== environment) return fail('verify environment')
    if (result.environment !== environment) return fail('result environment')
    if (result.nonce !== request.nonce) return fail('nonce')
    if (result.protocol_version !== PROTOCOL_VERSION) return fail('protocol version')
    if (proof?.identifier !== CREDENTIAL) return fail('credential')
    // World accepts a changed tail of the session id and echoes it back. Only the whole saved string counts.
    const expected = sessionId(record)
    if (typeof result.session_id !== 'string' || !result.session_id) return fail('no session')
    if (expected !== null && result.session_id !== expected) return fail('session')
    const nullifier = sessionNullifierOf(proof?.session_nullifier)
    if (nullifier === null) return fail('no nullifier')
    const key = nullifier.toString(16)
    if (record.nullifiers.includes(key)) return fail('nullifier reused')
    return { ok: true, value: commit(record, request, key) }
  }

  async function completeBudget(id: string, result: IdkitResult): Promise<WorldRequestView> {
    // With no budget yet, createSession makes a new session and there is nothing to compare with.
    // A new budget on top of one must prove the saved session.
    const checked = await check(
      id,
      result,
      (record) => budgetOf(record)?.sessionId ?? null,
      (record, request, nullifier) => {
        record.nullifiers.push(nullifier)
        record.budget = { id: request.id, amount: request.amount, sessionId: result.session_id as string, used: '0', nullifier }
        request.state = 'done'
        request.message = BUDGET_SET
        store.write(record)
        return viewOf(request)
      },
    )
    return checked.ok ? checked.value : checked.view
  }

  async function completeHold(id: string, result: IdkitResult): Promise<WorldRequestView> {
    const checked = await check(
      id,
      result,
      (record) => budgetOf(record)?.sessionId ?? '',
      (record, request, nullifier) => {
        const budget = budgetOf(record)
        const amount = BigInt(request.amount)
        // Gas may have been taken from the budget while the person was approving.
        if (!budget) return { go: false as const, view: close(record, request, NOT_APPROVED, 'no budget') }
        if (amount > leftOf(budget)) return { go: false as const, view: close(record, request, OVER_BUDGET, 'over budget') }
        // One write: the nullifier is taken, the budget is charged and the request leaves "waiting" together,
        // before any money moves. A crash after this leaves no hold and a spent nullifier, so nothing can be replayed.
        record.nullifiers.push(nullifier)
        budget.used = (BigInt(budget.used) + amount).toString()
        record.lastApproval = result
        request.state = 'creating'
        request.message = 'Setting up the hold…'
        store.write(record)
        return { go: true as const, request, amount, budgetId: budget.id }
      },
    )
    if (!checked.ok) return checked.view
    if (!checked.value.go) return checked.value.view
    const { request, amount, budgetId } = checked.value

    let released = false
    try {
      await ports.createHold(amount)
      request.state = 'done'
      request.message = `Held ${amountOnScreen(request.amount)} for your agent.`
    } catch (error) {
      console.error('world: hold failed:', error instanceof Error ? error.message : 'unknown')
      request.state = 'closed'
      request.message = error instanceof HoldError ? error.message : SETUP_FAILED
      // A HoldError comes before the deposit, and any gas reserve sent for the withdrawal has been swept back to the
      // buyer by then. Anything else may have left money in the hold, so it stays charged.
      released = error instanceof HoldError
    }
    const latest = store.read()
    latest.request = request
    const charged = budgetOf(latest)
    if (released && charged?.id === budgetId) charged.used = (BigInt(charged.used) - amount).toString()
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

  /**
   * The replay test: sends the previous hold's proof for the new hold. It never makes a hold, because that proof
   * carries the previous hold's signal, and the screen reads "Not approved: this approval is for another hold."
   */
  async function useLastApproval(id: string): Promise<WorldRequestView> {
    const { record, request } = live(id)
    if (request.state !== 'waiting' || request.kind !== 'hold' || record.lastApproval === null) return viewOf(request)
    return complete(id, record.lastApproval)
  }

  /**
   * Takes money out of the budget for something that is not a hold, such as gas sent to the hold wallet.
   * It refuses without a budget or past what is left, so nothing reaches the hold wallet outside an approved budget.
   */
  function spend(amount: bigint): void {
    const record = current()
    const budget = budgetOf(record)
    if (!budget || amount > leftOf(budget)) throw new WorldError(403, OVER_BUDGET)
    budget.used = (BigInt(budget.used) + amount).toString()
    store.write(record)
  }

  function status(): WorldStatus {
    const record = current()
    const budget = budgetOf(record)
    return {
      enabled: true,
      environment,
      budgetSet: budget !== null,
      budgetLeft: budget ? formatUsdc(leftOf(budget)) : null,
      hasLastApproval: record.lastApproval !== null,
      request: record.request ? viewOf(record.request) : null,
    }
  }

  return { startBudget, startHold, complete, cancel, useLastApproval, spend, status }
}

export type WorldService = ReturnType<typeof createWorldService>

/** The part of the contract client that sends gas to a wallet. */
export interface GasClient {
  gasCost(gas: bigint): Promise<bigint>
  usdcBalance(who: Address): Promise<bigint>
  transferUsdc(fromKey: Hex, to: Address, amount: bigint): Promise<void>
  ensureGas(fromKey: Hex, to: Address, gas: bigint): Promise<bigint>
}

/**
 * Production only. Gas for the hold wallet's contract calls is taken from the approved budget before it is sent,
 * the same way ensureGas works, and nothing is sent when the budget has no room.
 */
export function gasFromBudget<C extends GasClient>(client: C, spend: (amount: bigint) => void): C {
  return {
    ...client,
    async ensureGas(fromKey: Hex, to: Address, gas: bigint): Promise<bigint> {
      const [cost, balance] = await Promise.all([client.gasCost(gas), client.usdcBalance(to)])
      if (balance >= cost) return 0n
      const missing = cost - balance
      spend(missing)
      await client.transferUsdc(fromKey, to, missing)
      return missing
    },
  }
}
