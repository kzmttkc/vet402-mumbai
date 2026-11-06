import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { hashSignal } from '@worldcoin/idkit-core/hashing'
import { COMPARISON_EXTRA_HOLD, createDemoService, fromApprovedHold } from '../demo'
import type { DemoPorts } from '../demo'
import { createHoldService, HoldError } from '../hold'
import type { HoldPorts } from '../hold'
import { createHoldStore } from '../holdStore'
import {
  ANOTHER_HOLD,
  BUDGET_SET,
  createWorldPorts,
  createWorldService,
  gasFromBudget,
  NOT_APPROVED,
  OVER_BUDGET,
  readWorldConfig,
  SELFIE_NEEDED,
  SELFIE_UNAVAILABLE,
  WAITING,
  WorldError,
} from '../world'
import type { IdkitParams, VerifyAnswer, WorldEnvironment } from '../world'
import { mountWorld, refuseCrossSite, SESSION_HEADER } from '../worldRoutes'
import { createWorldStore } from '../worldStore'
import { SELLER_C_EXTRA_HOLD } from '../demo'
import { memoryStore } from './helpers'

// Every test works inside its own temporary folder. World is always a stand-in here: nothing goes to developer.world.org.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'world-test-'))
  expect(realpathSync(dir).startsWith(realpathSync(os.tmpdir()))).toBe(true)
  spyOn(console, 'warn').mockImplementation(() => {})
  spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const TOKEN = 'test-session-token'

type Proofs = { responses?: Array<{ identifier?: unknown } | null> }

/** World's answer when every proof in the result passed: one line per proof, named as IDKit named it. */
function passed(result: unknown, environment: unknown = 'staging'): VerifyAnswer {
  const proofs = (result as Proofs | null)?.responses ?? []
  return { success: true, environment, results: proofs.map((proof) => ({ identifier: proof?.identifier, success: true })) }
}

/** A stand-in for developer.world.org that passes every proof it is sent. */
const passingFetch = (environment: string) =>
  ((_url: string, init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(passed(JSON.parse(String(init?.body ?? '{}')), environment))))) as unknown as typeof fetch
const SESSION = `session_${'ab'.repeat(32)}${'cd'.repeat(32)}`
const usdc = (value: number) => BigInt(Math.round(value * 1_000_000))

function fakeHoldPorts() {
  const deposits: bigint[] = []
  const state = { buyer: usdc(100), available: 0n, depositFails: false }
  const ports: HoldPorts = {
    buyerWallet: () => Promise.resolve(state.buyer),
    hold: () => Promise.resolve({ wallet: 0n, available: state.available }),
    gasReserve: () => Promise.resolve(0n),
    fundHoldWallet: () => Promise.resolve(),
    withdrawToBuyer: (amount) => {
      state.available -= amount
      state.buyer += amount
      return Promise.resolve()
    },
    sweepToBuyer: () => Promise.resolve(),
    depositForHold: (amount) => {
      if (state.depositFails) return Promise.reject(new Error('rpc down'))
      deposits.push(amount)
      state.buyer -= amount
      state.available += amount
      return Promise.resolve()
    },
  }
  return { ports, deposits, state }
}

function setup(options: { ttlMs?: number; environment?: WorldEnvironment } = {}) {
  const clock = { now: 1_000_000 }
  const hold = fakeHoldPorts()
  const holds = createHoldService(hold.ports, createHoldStore(dir))
  const verifyCalls: unknown[] = []
  const verifyAnswer: { current: (result: unknown) => Promise<VerifyAnswer> } = {
    current: (result) => Promise.resolve(passed(result, options.environment ?? 'staging')),
  }
  let signs = 0
  const store = createWorldStore(dir)
  const world = createWorldService({
    appId: 'app_staging_test',
    rpId: 'rp_test',
    store,
    environment: options.environment,
    now: () => clock.now,
    ttlMs: options.ttlMs,
    ports: {
      sign: () => {
        signs += 1
        return { sig: `sig-${signs}`, nonce: `0x${signs.toString(16).padStart(4, '0')}`, createdAt: 10, expiresAt: 130 }
      },
      verify: (result) => {
        verifyCalls.push(result)
        return verifyAnswer.current(result)
      },
      createHold: (amount) => holds.start(amount),
    },
  })
  return { world, clock, hold, verifyCalls, verifyAnswer, store }
}

type Started = { request: { id: string }; idkit: IdkitParams }

// Budget proofs get nullifiers from 9001 up, so they never meet the small ones the hold tests pick.
let budgetNullifier = 9000

/** What IDKit returns for createSession with the budget's signal: one proof with a signal hash and a session nullifier. */
function sessionResult(started: Started, sessionId = SESSION, nullifier = String(++budgetNullifier)) {
  return {
    protocol_version: '4.0',
    nonce: started.idkit.rp_context.nonce,
    environment: 'staging',
    session_id: sessionId,
    responses: [
      {
        identifier: 'proof_of_human',
        signal_hash: hashSignal(started.idkit.signal as string),
        proof: ['1', '2', '3', '4', '5'],
        session_nullifier: [nullifier, '888'],
        issuer_schema_id: 1,
        expires_at_min: 1,
      },
    ],
  }
}

/** The selfie check's own nullifier, kept apart from the Proof of Human one the test picks. */
function selfieNullifierFor(nullifier: string): string {
  try {
    return (BigInt(nullifier) + 10n ** 40n).toString()
  } catch {
    return nullifier
  }
}

/** The selfie check World App adds for a hold above the selfie line. */
function selfieProof(started: Started, nullifier: string) {
  return {
    identifier: 'selfie',
    signal_hash: hashSignal(started.idkit.signal as string),
    proof: ['1', '2', '3', '4', '5'],
    session_nullifier: [selfieNullifierFor(nullifier), '777'],
    issuer_schema_id: 11,
    expires_at_min: 1,
    sybil_score: 0,
  }
}

/** What IDKit returns for proveSession: Proof of Human, plus the selfie check when the backend asked for one. */
function proofFor(started: Started, nullifier: string, change: Record<string, unknown> = {}) {
  return {
    protocol_version: '4.0',
    nonce: started.idkit.rp_context.nonce,
    environment: 'staging',
    session_id: started.idkit.session_id,
    responses: [
      {
        identifier: 'proof_of_human',
        signal_hash: hashSignal(started.idkit.signal as string),
        proof: ['1', '2', '3', '4', '5'],
        session_nullifier: [nullifier, '777'],
        issuer_schema_id: 1,
        expires_at_min: 1,
      },
      ...(started.idkit.credentials?.includes('selfie') ? [selfieProof(started, nullifier)] : []),
    ],
    ...change,
  }
}

async function withBudget(options: { ttlMs?: number } = {}, amount = usdc(10)) {
  const ctx = setup(options)
  const started = ctx.world.startBudget(amount)
  const view = await ctx.world.complete(started.request.id, sessionResult(started))
  expect(view.message).toBe(BUDGET_SET)
  ctx.verifyCalls.length = 0
  return ctx
}

describe('refusals: no hold is created', () => {
  test('Cancel request ends it at once with the same sentence', async () => {
    const { world, hold } = await withBudget()
    const started = world.startHold(usdc(1))
    expect(started.request).toMatchObject({ state: 'waiting', message: WAITING })

    expect(world.cancel(started.request.id)).toMatchObject({ state: 'closed', message: NOT_APPROVED })

    const late = await world.complete(started.request.id, proofFor(started, '1'))
    expect(late.message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('2 minutes: an overdue pending hold is closed and a late proof is refused', async () => {
    const { world, clock, hold, verifyCalls } = await withBudget()
    const started = world.startHold(usdc(1))

    clock.now += 119_999
    expect(world.status().request?.state).toBe('waiting')
    clock.now += 1
    expect(world.status().request).toMatchObject({ state: 'closed', message: NOT_APPROVED })

    const late = await world.complete(started.request.id, proofFor(started, '1'))
    expect(late.message).toBe(NOT_APPROVED)
    expect(verifyCalls).toEqual([])
    expect(hold.deposits).toEqual([])
  })

  test('2 minutes: the pending hold is closed on time even if nobody polls', async () => {
    const { world, clock, store } = await withBudget({ ttlMs: 5 })
    world.startHold(usdc(1))
    clock.now += 5
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(store.read().request).toMatchObject({ state: 'closed', message: NOT_APPROVED })
  })

  test('2 minutes: the request does not outlive the signature', () => {
    const fetchImpl = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch
    const config = { appId: 'app_x', rpId: 'rp_x', signerKey: `0x${randomBytes(32).toString('hex')}` }
    const signed = createWorldPorts(config, () => Promise.resolve(), fetchImpl).sign()
    expect(signed.expiresAt - signed.createdAt).toBe(120)
  })

  const failedVerify: Array<[string, () => Promise<VerifyAnswer>]> = [
    ['success is false', () => Promise.resolve({ success: false, environment: 'staging' })],
    ['the environment is not staging', () => Promise.resolve({ success: true, environment: 'production' })],
    ['the environment is missing', () => Promise.resolve({ success: true, environment: undefined })],
    ['the request fails', () => Promise.reject(new Error('network'))],
  ]
  for (const [name, answer] of failedVerify) {
    test(`verify failure: ${name}`, async () => {
      const { world, hold, verifyAnswer } = await withBudget()
      const started = world.startHold(usdc(1))
      verifyAnswer.current = answer
      const view = await world.complete(started.request.id, proofFor(started, '1'))
      expect(view).toMatchObject({ state: 'closed', message: NOT_APPROVED })
      expect(hold.deposits).toEqual([])
    })
  }

  test('the IDKit result says another environment', async () => {
    const { world, hold } = await withBudget()
    const started = world.startHold(usdc(1))
    const view = await world.complete(started.request.id, proofFor(started, '1', { environment: 'production' }))
    expect(view.message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('another session: a wholly different session id', async () => {
    const { world, hold } = await withBudget()
    const started = world.startHold(usdc(1))
    const other = `session_${'ef'.repeat(64)}`
    const view = await world.complete(started.request.id, proofFor(started, '1', { session_id: other }))
    expect(view).toMatchObject({ state: 'closed', message: NOT_APPROVED })
    expect(hold.deposits).toEqual([])
  })

  test('another session: only the second half changed, which World itself lets through', async () => {
    const { world, hold } = await withBudget()
    const started = world.startHold(usdc(1))
    const tail = `session_${'ab'.repeat(32)}${'00'.repeat(32)}`
    const view = await world.complete(started.request.id, proofFor(started, '1', { session_id: tail }))
    expect(view.message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('signal mismatch: a proof made for another hold reads its own sentence', async () => {
    const { world, hold, verifyCalls } = await withBudget()
    const started = world.startHold(usdc(1))
    const other = { ...started, idkit: { ...started.idkit, signal: 'hold_other:1' } }
    const view = await world.complete(started.request.id, proofFor(other, '1'))
    expect(view).toMatchObject({ state: 'closed', message: ANOTHER_HOLD })
    expect(verifyCalls).toEqual([])
    expect(hold.deposits).toEqual([])
  })

  test('signal mismatch: the same hold id with another amount is another hold', async () => {
    const { world, hold } = await withBudget()
    const started = world.startHold(usdc(1))
    const other = { ...started, idkit: { ...started.idkit, signal: `${started.request.id}:2` } }
    const view = await world.complete(started.request.id, proofFor(other, '1'))
    expect(view.message).toBe(ANOTHER_HOLD)
    expect(hold.deposits).toEqual([])
  })

  test('signal mismatch: checked before the nonce and the nullifier', async () => {
    const { world, hold } = await withBudget()
    const first = world.startHold(usdc(1))
    await world.complete(first.request.id, proofFor(first, '1'))

    const second = world.startHold(usdc(2))
    // Bad nonce, reused nullifier and bad signal together: the signal is what the screen must report.
    const view = await world.complete(second.request.id, proofFor(first, '1', { nonce: 'wrong' }))
    expect(view.message).toBe(ANOTHER_HOLD)
    expect(hold.deposits).toEqual([usdc(1)])
  })

  test('signal mismatch: "Use the last approval" sends the previous proof and is refused', async () => {
    const { world, hold } = await withBudget()
    const first = world.startHold(usdc(1))
    expect(world.status().hasLastApproval).toBe(false)
    await world.complete(first.request.id, proofFor(first, '1'))
    expect(world.status().hasLastApproval).toBe(true)

    const second = world.startHold(usdc(1))
    const view = await world.useLastApproval(second.request.id)
    expect(view).toMatchObject({ state: 'closed', message: ANOTHER_HOLD })
    expect(hold.deposits).toEqual([usdc(1)])
  })

  test('a result with no signal is refused with the plain sentence', async () => {
    const { world, hold } = await withBudget()
    const started = world.startHold(usdc(1))
    const view = await world.complete(started.request.id, { ...proofFor(started, '1'), responses: [] })
    expect(view.message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('same nullifier: the second time is refused', async () => {
    const { world, hold } = await withBudget()
    const first = world.startHold(usdc(1))
    expect((await world.complete(first.request.id, proofFor(first, '4242'))).state).toBe('done')

    const second = world.startHold(usdc(2))
    const view = await world.complete(second.request.id, proofFor(second, '4242'))
    expect(view).toMatchObject({ state: 'closed', message: NOT_APPROVED })
    expect(hold.deposits).toEqual([usdc(1)])
  })

  test('same nullifier: compared as an integer, so another spelling is the same one', async () => {
    const { world, hold } = await withBudget()
    const first = world.startHold(usdc(1))
    await world.complete(first.request.id, proofFor(first, '4242'))

    for (const spelling of ['0x1092', '0x001092']) {
      const next = world.startHold(usdc(1))
      const view = await world.complete(next.request.id, proofFor(next, spelling))
      expect(view.message).toBe(NOT_APPROVED)
    }
    expect(hold.deposits).toEqual([usdc(1)])
  })

  test('same nullifier: a value above 256 bits or not a number is refused', async () => {
    const { world, hold } = await withBudget()
    for (const bad of [`0x1${'0'.repeat(64)}`, '', 'abc', ' 1']) {
      const started = world.startHold(usdc(1))
      const view = await world.complete(started.request.id, proofFor(started, bad))
      expect(view.message).toBe(NOT_APPROVED)
    }
    expect(hold.deposits).toEqual([])
  })

  test('nonce mismatch', async () => {
    const { world, hold } = await withBudget()
    const started = world.startHold(usdc(1))
    const view = await world.complete(started.request.id, proofFor(started, '1', { nonce: '0xdead' }))
    expect(view).toMatchObject({ state: 'closed', message: NOT_APPROVED })
    expect(hold.deposits).toEqual([])
  })

  test('a cancel while World is answering still wins', async () => {
    const { world, hold, verifyAnswer } = await withBudget()
    const started = world.startHold(usdc(1))
    let answer: (value: VerifyAnswer) => void = () => {}
    verifyAnswer.current = () => new Promise((resolve) => (answer = resolve))

    const pending = world.complete(started.request.id, proofFor(started, '1'))
    world.cancel(started.request.id)
    answer({ success: true, environment: 'staging' })

    expect((await pending).message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('the same proof sent twice at once makes one hold', async () => {
    const { world, hold } = await withBudget()
    const started = world.startHold(usdc(1))
    await Promise.all([
      world.complete(started.request.id, proofFor(started, '1')),
      world.complete(started.request.id, proofFor(started, '1')),
    ])
    expect(hold.deposits).toEqual([usdc(1)])
  })

  test('starting again leaves the earlier pending hold unable to be approved', async () => {
    const { world, hold } = await withBudget()
    const first = world.startHold(usdc(1))
    world.startHold(usdc(2))
    await expect(world.complete(first.request.id, proofFor(first, '1'))).rejects.toBeInstanceOf(WorldError)
    expect(hold.deposits).toEqual([])
  })

  test('a hold needs a budget and cannot go above it', async () => {
    const empty = setup()
    expect(() => empty.world.startHold(usdc(1))).toThrow(NOT_APPROVED)

    const { world } = await withBudget({}, usdc(5))
    expect(() => world.startHold(usdc(5.01))).toThrow(OVER_BUDGET)
    expect(world.startHold(usdc(5)).request.id).toStartWith('hold_')
  })

  test('budget step: cancel, failed verify and a wrong nonce save nothing', async () => {
    const { world, verifyAnswer, store } = setup()

    const cancelled = world.startBudget(usdc(1))
    expect(world.cancel(cancelled.request.id).message).toBe(NOT_APPROVED)

    const wrongNonce = world.startBudget(usdc(1))
    const nonceView = await world.complete(wrongNonce.request.id, { ...sessionResult(wrongNonce), nonce: 'x' })
    expect(nonceView.message).toBe(NOT_APPROVED)

    const failed = world.startBudget(usdc(1))
    verifyAnswer.current = () => Promise.resolve({ success: false, environment: 'staging' })
    expect((await world.complete(failed.request.id, sessionResult(failed))).message).toBe(NOT_APPROVED)

    expect(store.read().budget).toBeNull()
  })
})

describe('the path that goes through', () => {
  test('setting the budget saves the whole session id and the screen reads "Budget set."', async () => {
    const { world, verifyCalls, store } = setup()
    const started = world.startBudget(usdc(10))
    expect(started.idkit.session_id).toBeUndefined()
    expect(started.idkit.signal).toBe(`budget:10:${started.request.id}`)

    const result = sessionResult(started, SESSION, '0x5eed')
    const view = await world.complete(started.request.id, result)

    expect(view).toMatchObject({ state: 'done', message: BUDGET_SET })
    expect(verifyCalls).toEqual([result])
    expect(store.read().budget).toEqual({
      id: started.request.id,
      amount: usdc(10).toString(),
      sessionId: SESSION,
      used: '0',
      nullifier: '5eed',
    })
    expect(world.status()).toMatchObject({ budgetSet: true, budgetLeft: '10' })
  })

  test('a saved budget is replaced only when a new budget proof passes', async () => {
    const { world, store } = await withBudget()
    const before = store.read().budget

    const refused = world.startBudget(usdc(20))
    world.cancel(refused.request.id)
    expect(store.read().budget).toEqual(before)

    // A new budget is a proof of the saved session: another person's session is refused.
    const other = `session_${'12'.repeat(64)}`
    const stranger = world.startBudget(usdc(20))
    expect(stranger.idkit.session_id).toBe(SESSION)
    expect((await world.complete(stranger.request.id, sessionResult(stranger, other))).message).toBe(NOT_APPROVED)
    expect(store.read().budget).toEqual(before)

    const next = world.startBudget(usdc(20))
    expect((await world.complete(next.request.id, sessionResult(next))).message).toBe(BUDGET_SET)
    expect(store.read().budget).toMatchObject({ id: next.request.id, amount: usdc(20).toString(), sessionId: SESSION, used: '0' })
  })

  test('sending a finished budget request again changes nothing', async () => {
    const { world, store } = setup()
    const first = world.startBudget(usdc(1))
    await world.complete(first.request.id, sessionResult(first))
    // The stored request is done, so sending it again changes nothing.
    const again = await world.complete(first.request.id, sessionResult(first, 'session_other'))
    expect(again.message).toBe(BUDGET_SET)
    expect(store.read().budget?.sessionId).toBe(SESSION)
  })

  test('the hold is created through the existing hold service', async () => {
    const { world, hold, store } = await withBudget()
    const started = world.startHold(usdc(1.5))

    expect(hold.deposits).toEqual([])
    expect(store.read().request).toMatchObject({ kind: 'hold', amount: usdc(1.5).toString(), state: 'waiting' })
    expect(store.read().request).not.toHaveProperty('jobId')
    expect(started.idkit.session_id).toBe(SESSION)
    expect(started.idkit.signal).toBe(`${started.request.id}:1.5`)

    const view = await world.complete(started.request.id, proofFor(started, '99'))

    expect(view).toMatchObject({ state: 'done', message: 'Held 1.5 USDC for your agent.' })
    expect(hold.deposits).toEqual([usdc(1.5)])
    // 1.5 USDC is above the selfie line, so the hold spends two nullifiers: Proof of Human's, then the selfie check's.
    expect(store.read().nullifiers.slice(-2)).toEqual([(99).toString(16), BigInt(selfieNullifierFor('99')).toString(16)])
    expect(store.read().nullifiers).toHaveLength(3)
  })

  test('the same person approves a second hold with a new nullifier', async () => {
    const { world, hold } = await withBudget()
    const first = world.startHold(usdc(1))
    expect((await world.complete(first.request.id, proofFor(first, '1'))).state).toBe('done')

    const second = world.startHold(usdc(2))
    const view = await world.complete(second.request.id, proofFor(second, '2'))

    expect(view.message).toBe('Held 2 USDC for your agent.')
    // The first hold's leftover stays, so the second deposit is only the difference.
    expect(hold.deposits).toEqual([usdc(1), usdc(1)])
  })

  test('a hold that fails after approval keeps the nullifier spent and shows the hold error', async () => {
    const { world, hold, store } = await withBudget()
    hold.state.depositFails = true
    const started = world.startHold(usdc(1))

    const view = await world.complete(started.request.id, proofFor(started, '7'))

    expect(view).toMatchObject({ state: 'closed', message: 'The hold could not be set up. Please try again.' })
    expect(store.read().nullifiers.at(-2)).toBe('7')
    // The deposit may have reached the chain, so the budget stays charged.
    expect(store.read().budget?.used).toBe(usdc(1).toString())
  })

  test('a balance too low shows the existing sentence', async () => {
    const ctx = setup()
    const failing = createWorldService({
      appId: 'app_x',
      rpId: 'rp_x',
      store: ctx.store,
      ports: {
        sign: () => ({ sig: 's', nonce: `0x${randomBytes(4).toString('hex')}`, createdAt: 1, expiresAt: 121 }),
        verify: (result) => Promise.resolve(passed(result, 'staging')),
        createHold: () => Promise.reject(new HoldError('NOT_ENOUGH_BALANCE', 'Your balance is too low for this hold.')),
      },
    })
    const budget = failing.startBudget(usdc(1))
    await failing.complete(budget.request.id, sessionResult(budget))
    const started = failing.startHold(usdc(1))
    const view = await failing.complete(started.request.id, proofFor(started, '3'))
    expect(view.message).toBe('Your balance is too low for this hold.')
  })

  test('a restart in the middle of a hold does not show it as running', async () => {
    const { world, store } = await withBudget()
    const started = world.startHold(usdc(1))
    const record = store.read()
    if (record.request) record.request.state = 'creating'
    store.write(record)

    const restarted = createWorldService({
      appId: 'app_x',
      rpId: 'rp_x',
      store,
      ports: {
        sign: () => ({ sig: 's', nonce: 'n', createdAt: 1, expiresAt: 121 }),
        verify: (result) => Promise.resolve(passed(result, 'staging')),
        createHold: () => Promise.resolve(),
      },
    })
    expect(restarted.status().request).toMatchObject({ id: started.request.id, state: 'closed' })
  })

  test('nullifiers survive a restart, and a damaged file refuses instead of forgetting them', async () => {
    const { world, store } = await withBudget()
    const started = world.startHold(usdc(1))
    await world.complete(started.request.id, proofFor(started, '11'))
    expect(createWorldStore(dir).read().nullifiers).toEqual(store.read().nullifiers)

    await Bun.write(path.join(dir, 'world.json'), '{not json')
    expect(() => createWorldStore(dir).read()).toThrow()
  })
})

describe('what the browser gets', () => {
  test('a status and a view carry no World ID value', async () => {
    const { world } = await withBudget()
    const started = world.startHold(usdc(1))
    await world.complete(started.request.id, proofFor(started, '0xfeedface'))

    const shown = JSON.stringify(world.status())
    for (const value of [SESSION, 'feedface', started.idkit.rp_context.nonce, started.idkit.rp_context.signature]) {
      expect(shown).not.toContain(value)
    }
  })

  test('rp_context is built from the signature and the key never leaves the backend', () => {
    const signerKey = `0x${randomBytes(32).toString('hex')}`
    const config = { appId: 'app_staging_x', rpId: 'rp_x', signerKey }
    const world = createWorldService({
      appId: config.appId,
      rpId: config.rpId,
      store: createWorldStore(dir),
      ports: createWorldPorts(config, () => Promise.resolve(), (() => Promise.reject(new Error('no'))) as unknown as typeof fetch),
    })

    const one = world.startBudget(usdc(1))
    const two = world.startBudget(usdc(1))

    expect(one.idkit).toMatchObject({ app_id: 'app_staging_x', environment: 'staging' })
    expect(Object.keys(one.idkit.rp_context).sort()).toEqual(['created_at', 'expires_at', 'nonce', 'rp_id', 'signature'])
    expect(one.idkit.rp_context.rp_id).toBe('rp_x')
    expect(one.idkit.rp_context.nonce).not.toBe(two.idkit.rp_context.nonce)
    expect(one.idkit.rp_context.signature).not.toBe(two.idkit.rp_context.signature)
    expect(JSON.stringify(one)).not.toContain(signerKey.slice(2))
    expect(readFileSync(path.join(dir, 'world.json'), 'utf8')).not.toContain(signerKey.slice(2))
  })
})

describe('forwarding to World', () => {
  const config = { appId: 'app_x', rpId: 'rp_abc', signerKey: 'unused' }
  const answering = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = ((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(JSON.stringify(body), { status }))
    }) as unknown as typeof fetch
    return { calls, ports: createWorldPorts(config, () => Promise.resolve(), fetchImpl) }
  }

  test('sends the result unchanged to the verify endpoint', async () => {
    const { calls, ports } = answering(200, { success: true, environment: 'staging' })
    const result = { nonce: 'n', responses: [{ proof: ['1'] }], session_id: 's' }

    expect(await ports.verify(result)).toEqual({ success: true, environment: 'staging' })
    expect(calls[0].url).toBe('https://developer.world.org/api/v4/verify/rp_abc')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(calls[0].init?.body as string)).toEqual(result)
  })

  test('a refusal or an unreadable answer is not a success', async () => {
    expect((await answering(400, { success: true, environment: 'staging' }).ports.verify({})).success).toBe(false)
    expect((await answering(200, { success: 'yes' }).ports.verify({})).success).toBe(false)
  })
})

describe('the join with the rest of the app', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function listen(env: Record<string, string | undefined>, verifyBody?: unknown) {
    const hold = fakeHoldPorts()
    const holds = createHoldService(hold.ports, createHoldStore(dir))
    const app = express()
    app.use(express.json())
    const worldOn = mountWorld(app, {
      env,
      dataDir: dir,
      token: TOKEN,
      createHold: (amount) => holds.start(amount),
      fetchImpl: verifyBody === undefined ? passingFetch('staging') : ((() => Promise.resolve(new Response(JSON.stringify(verifyBody)))) as unknown as typeof fetch),
    })
    // The same plain route as server/index.ts, added after the World routes in the same order.
    app.post('/hold', (req, res) => {
      void holds.start(usdc(Number((req.body as { amount: string }).amount))).then(() => res.json({ ok: true }))
    })
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started))
    })
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (route: string, body: unknown = {}, token: string | null = TOKEN) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { [SESSION_HEADER]: token }) },
        body: JSON.stringify(body),
      })
    return { hold, holds, worldOn, base, post }
  }

  const fullEnv = () => ({
    WORLD_APP_ID: 'app_staging_x',
    WORLD_RP_ID: 'rp_x',
    WORLD_SIGNER_KEY: `0x${randomBytes(32).toString('hex')}`,
  })

  test('without the variables the hold stays as it is today and nothing is written', async () => {
    const { hold, worldOn, base, post } = await listen({})

    expect(worldOn).toBeNull()
    expect(await (await fetch(`${base}/world/status`)).json()).toEqual({ enabled: false })
    expect((await post('/world/budget', { amount: '1' })).status).toBe(404)
    expect((await post('/hold', { amount: '1' })).status).toBe(200)
    expect(hold.deposits).toEqual([usdc(1)])
    expect(existsSync(path.join(dir, 'world.json'))).toBe(false)
  })

  test('with only some of the variables the backend refuses to start and names only what is missing', () => {
    const key = `0x${randomBytes(32).toString('hex')}`
    expect(readWorldConfig({})).toBeNull()
    expect(() => readWorldConfig({ WORLD_SIGNER_KEY: key })).toThrow('WORLD_APP_ID, WORLD_RP_ID')
    try {
      readWorldConfig({ WORLD_SIGNER_KEY: key })
    } catch (error) {
      expect((error as Error).message).not.toContain(key)
    }
  })

  test('with the variables the plain route is closed, so an approval is the only way to a hold', async () => {
    const { hold, post } = await listen(fullEnv())
    const res = await post('/hold', { amount: '1' })
    expect(res.status).toBe(403)
    expect(hold.deposits).toEqual([])
  })

  test('budget and hold over HTTP, with World stood in for', async () => {
    const { hold, base, post } = await listen(fullEnv())

    expect((await post('/world/budget', { amount: 'abc' })).status).toBe(400)

    const budget = (await (await post('/world/budget', { amount: '5' })).json()) as Started
    const done = await post(`/world/requests/${budget.request.id}/complete`, { result: sessionResult(budget) })
    expect(await done.json()).toMatchObject({ message: BUDGET_SET })

    const started = (await (await post('/world/hold', { amount: '2' })).json()) as Started
    expect(await (await fetch(`${base}/world/status`)).json()).toMatchObject({ budgetSet: true, request: { message: WAITING } })
    const held = await post(`/world/requests/${started.request.id}/complete`, { result: proofFor(started, '5') })
    expect(await held.json()).toMatchObject({ state: 'done', message: 'Held 2 USDC for your agent.' })
    expect(hold.deposits).toEqual([usdc(2)])

    const next = (await (await post('/world/hold', { amount: '1' })).json()) as Started
    const reused = await post(`/world/requests/${next.request.id}/use-last-approval`)
    expect(await reused.json()).toMatchObject({ message: ANOTHER_HOLD })

    const another = (await (await post('/world/hold', { amount: '1' })).json()) as Started
    expect(await (await post(`/world/requests/${another.request.id}/cancel`)).json()).toMatchObject({ message: NOT_APPROVED })
    expect(hold.deposits).toEqual([usdc(2)])

    expect((await post('/world/requests/unknown/cancel')).status).toBe(404)
  })
})

describe('production: the real World App', () => {
  const production = { environment: 'production' } as const

  test('WORLD_ENVIRONMENT picks the environment, unset stays staging, and a typo refuses to start', () => {
    const base = { WORLD_APP_ID: 'app_x', WORLD_RP_ID: 'rp_x', WORLD_SIGNER_KEY: '0x01' }
    expect(readWorldConfig(base)?.environment).toBe('staging')
    expect(readWorldConfig({ ...base, WORLD_ENVIRONMENT: '' })?.environment).toBe('staging')
    expect(readWorldConfig({ ...base, WORLD_ENVIRONMENT: 'staging' })?.environment).toBe('staging')
    expect(readWorldConfig({ ...base, WORLD_ENVIRONMENT: 'production' })?.environment).toBe('production')
    for (const wrong of ['prod', 'Production', 'sandbox']) {
      expect(() => readWorldConfig({ ...base, WORLD_ENVIRONMENT: wrong })).toThrow('WORLD_ENVIRONMENT')
    }
    // The environment alone does not turn the approval on.
    expect(readWorldConfig({ WORLD_ENVIRONMENT: 'production' })).toBeNull()
  })

  test('IDKit is told "production" for both steps', async () => {
    const { world } = setup(production)
    const budget = world.startBudget(usdc(10))
    expect(budget.idkit.environment).toBe('production')
    await world.complete(budget.request.id, { ...sessionResult(budget), ...production })
    expect(world.startHold(usdc(1)).idkit.environment).toBe('production')
  })

  test('budget and hold go through when the verify answer and the result both say "production"', async () => {
    const { world, hold, verifyCalls } = setup(production)
    const budget = world.startBudget(usdc(10))
    const result = { ...sessionResult(budget), ...production }
    expect(await world.complete(budget.request.id, result)).toMatchObject({ state: 'done', message: BUDGET_SET })
    expect(verifyCalls).toEqual([result])

    const started = world.startHold(usdc(2))
    const view = await world.complete(started.request.id, proofFor(started, '42', production))
    expect(view).toMatchObject({ state: 'done', message: 'Held 2 USDC for your agent.' })
    expect(hold.deposits).toEqual([usdc(2)])
  })

  test('a staging proof or a staging verify answer is refused in production', async () => {
    const { world, store, verifyAnswer } = setup(production)
    const fromSimulator = world.startBudget(usdc(10))
    expect((await world.complete(fromSimulator.request.id, sessionResult(fromSimulator))).message).toBe(NOT_APPROVED)
    expect(store.read().budget).toBeNull()

    verifyAnswer.current = () => Promise.resolve({ success: true, environment: 'staging' })
    const stagingAnswer = world.startBudget(usdc(10))
    expect((await world.complete(stagingAnswer.request.id, { ...sessionResult(stagingAnswer), ...production })).message).toBe(
      NOT_APPROVED,
    )
    expect(store.read().budget).toBeNull()
  })

  test('the hold checks stay the same in production: signal, nonce, session and nullifier', async () => {
    const { world, hold } = setup(production)
    const budget = world.startBudget(usdc(10))
    await world.complete(budget.request.id, { ...sessionResult(budget), ...production })

    const staged = world.startHold(usdc(1))
    expect((await world.complete(staged.request.id, proofFor(staged, '1'))).message).toBe(NOT_APPROVED)

    const signal = world.startHold(usdc(1))
    const other = proofFor(signal, '2', production) as ReturnType<typeof proofFor> & { responses: Array<Record<string, unknown>> }
    other.responses[0].signal_hash = hashSignal('another-hold:1')
    expect((await world.complete(signal.request.id, other)).message).toBe(ANOTHER_HOLD)

    const nonce = world.startHold(usdc(1))
    expect((await world.complete(nonce.request.id, proofFor(nonce, '3', { ...production, nonce: '0xbad' }))).message).toBe(
      NOT_APPROVED,
    )

    const session = world.startHold(usdc(1))
    const otherSession = `session_${'ef'.repeat(64)}`
    expect(
      (await world.complete(session.request.id, proofFor(session, '4', { ...production, session_id: otherSession }))).message,
    ).toBe(NOT_APPROVED)

    const first = world.startHold(usdc(1))
    expect((await world.complete(first.request.id, proofFor(first, '5', production))).state).toBe('done')
    const again = world.startHold(usdc(1))
    expect((await world.complete(again.request.id, proofFor(again, '5', production))).message).toBe(NOT_APPROVED)

    expect(hold.deposits).toEqual([usdc(1)])
  })

  test('over HTTP the backend hands IDKit "production" only when WORLD_ENVIRONMENT says so', async () => {
    const signerKey = `0x${randomBytes(32).toString('hex')}`
    const env = { WORLD_APP_ID: 'app_x', WORLD_RP_ID: 'rp_x', WORLD_SIGNER_KEY: signerKey }
    const started = async (extra: Record<string, string>) => {
      const app = express()
      app.use(express.json())
      mountWorld(app, { env: { ...env, ...extra }, dataDir: mkdtempSync(path.join(dir, 'env-')), token: TOKEN, createHold: () => Promise.resolve() })
      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s))
      })
      try {
        const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/world/budget`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: TOKEN },
          body: JSON.stringify({ amount: '1' }),
        })
        return (await res.json()) as Started
      } finally {
        server.close()
      }
    }
    expect((await started({})).idkit.environment).toBe('staging')
    const prod = await started({ WORLD_ENVIRONMENT: 'production' })
    expect(prod.idkit.environment).toBe('production')
    expect(JSON.stringify(prod)).not.toContain(signerKey.slice(2))
    expect(() =>
      mountWorld(express(), { env: { ...env, WORLD_ENVIRONMENT: 'prod' }, dataDir: dir, createHold: () => Promise.resolve() }),
    ).toThrow('WORLD_ENVIRONMENT')
  })
})

describe('production keeps its own record', () => {
  test('a staging budget does not carry over, and the staging file is left as it was', async () => {
    const staging = createWorldService({
      appId: 'app_x',
      rpId: 'rp_x',
      store: createWorldStore(dir),
      ports: { sign: () => ({ sig: 's', nonce: '0x1', createdAt: 1, expiresAt: 2 }), verify: (result) => Promise.resolve(passed(result, 'staging')), createHold: () => Promise.resolve() },
    })
    const budget = staging.startBudget(usdc(5))
    await staging.complete(budget.request.id, sessionResult(budget))
    const before = readFileSync(path.join(dir, 'world.json'), 'utf8')

    const production = createWorldService({
      appId: 'app_x',
      rpId: 'rp_x',
      environment: 'production',
      store: createWorldStore(dir, 'production'),
      ports: { sign: () => ({ sig: 's', nonce: '0x2', createdAt: 1, expiresAt: 2 }), verify: (result) => Promise.resolve(passed(result, 'production')), createHold: () => Promise.resolve() },
    })
    expect(production.status().budgetSet).toBe(false)
    const fresh = production.startBudget(usdc(5))
    expect((await production.complete(fresh.request.id, { ...sessionResult(fresh), environment: 'production' })).message).toBe(BUDGET_SET)

    expect(existsSync(path.join(dir, 'world-production.json'))).toBe(true)
    expect(readFileSync(path.join(dir, 'world.json'), 'utf8')).toBe(before)
    expect(staging.status().budgetSet).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Production: every way the hold could grow, tried one by one. Each must go through an approval or be closed.

async function productionBudget(amount = usdc(1)) {
  const ctx = setup({ environment: 'production' })
  const started = ctx.world.startBudget(amount)
  const view = await ctx.world.complete(started.request.id, { ...sessionResult(started), environment: 'production' })
  expect(view.message).toBe(BUDGET_SET)
  ctx.verifyCalls.length = 0
  return ctx
}

async function approveHold(world: ReturnType<typeof setup>['world'], amount: bigint, nullifier: string) {
  const started = world.startHold(amount)
  return world.complete(started.request.id, proofFor(started, nullifier, { environment: 'production' }))
}

function fakeGasClient(balance = 0n, cost = usdc(0.01)) {
  const transfers: bigint[] = []
  const client = {
    gasCost: () => Promise.resolve(cost),
    usdcBalance: () => Promise.resolve(balance),
    transferUsdc: (_from: `0x${string}`, _to: `0x${string}`, amount: bigint) => {
      transfers.push(amount)
      return Promise.resolve()
    },
    ensureGas: () => Promise.reject(new Error('the plain ensureGas must not run in production')),
  }
  return { client, transfers }
}

const KEY = `0x${'11'.repeat(32)}` as const
const WALLET = `0x${'22'.repeat(20)}` as const

describe('production: no way grows the hold without an approval', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function listenProduction() {
    const hold = fakeHoldPorts()
    const holds = createHoldService(hold.ports, createHoldStore(dir))
    const app = express()
    app.use(express.json())
    mountWorld(app, {
      env: { WORLD_APP_ID: 'app_x', WORLD_RP_ID: 'rp_x', WORLD_SIGNER_KEY: `0x${randomBytes(32).toString('hex')}`, WORLD_ENVIRONMENT: 'production' },
      dataDir: dir,
      token: TOKEN,
      createHold: (amount) => holds.start(amount),
      fetchImpl: passingFetch('production'),
    })
    app.post('/hold', (_req, res) => void holds.start(usdc(1)).then(() => res.json({ ok: true })))
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (route: string, body: unknown = {}) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: TOKEN },
        body: JSON.stringify(body),
      })
    return { hold, post }
  }

  test('path 1, the plain hold route: refused, nothing deposited', async () => {
    const { hold, post } = await listenProduction()
    expect((await post('/hold', { amount: '1' })).status).toBe(403)
    expect(hold.deposits).toEqual([])
  })

  test('path 2, a World hold with no budget: refused before any QR code', async () => {
    const { hold, post } = await listenProduction()
    const res = await post('/world/hold', { amount: '1' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: NOT_APPROVED })
    expect(hold.deposits).toEqual([])
  })

  test('path 3, a World hold past the budget: refused before any QR code', async () => {
    const { hold, post } = await listenProduction()
    const budget = (await (await post('/world/budget', { amount: '1' })).json()) as Started
    const done = await post(`/world/requests/${budget.request.id}/complete`, {
      result: { ...sessionResult(budget), environment: 'production' },
    })
    expect(await done.json()).toMatchObject({ message: BUDGET_SET })
    const res = await post('/world/hold', { amount: '1.01' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: OVER_BUDGET })
    expect(hold.deposits).toEqual([])
  })

  test('path 4, the replay test: the last approval is refused for the new hold and nothing is held', async () => {
    const { world, hold } = await productionBudget()
    expect((await approveHold(world, usdc(0.5), '1')).state).toBe('done')
    const next = world.startHold(usdc(0.3))
    expect(await world.useLastApproval(next.request.id)).toMatchObject({ state: 'closed', message: ANOTHER_HOLD })
    expect(hold.deposits).toEqual([usdc(0.5)])
    expect(world.status().budgetLeft).toBe('0.5')
  })

  test('path 5, the compare scene: it spends from the approved hold and adds nothing to it', async () => {
    const grown: bigint[] = []
    let prepared = 0
    const ports: DemoPorts = {
      holdAvailable: () => Promise.resolve(COMPARISON_EXTRA_HOLD - 1n),
      growHold: (amount) => {
        grown.push(amount)
        return Promise.resolve()
      },
      prepare: () => {
        prepared += 1
        return Promise.reject(new Error('no seller in this test'))
      },
      confirmOnePayment: () => Promise.resolve(false),
      countPayments: () => Promise.resolve(0),
    }
    const demos = createDemoService(
      { ...ports, growHold: fromApprovedHold(ports) },
      { a: { name: 'A', url: 'http://a', address: '0xa' }, b: { name: 'B', url: 'http://b', address: '0xb' } },
      memoryStore(),
    )
    const run = demos.start('compare')
    await demos.settled(run.id)
    expect(demos.get(run.id)).toMatchObject({ state: 'failed', error: 'The hold doesn’t cover this. Hold more first.' })
    expect(grown).toEqual([])
    expect(prepared).toBe(0)
  })

  test('path 6, the Seller C scene: the extra hold is never added, the approved hold must cover it', async () => {
    // fromApprovedHold is handed only a reader of the hold, so it has no way to deposit.
    const reads: bigint[] = []
    const reader = (available: bigint) => ({
      holdAvailable: () => {
        reads.push(available)
        return Promise.resolve(available)
      },
    })
    await expect(fromApprovedHold(reader(0n))(SELLER_C_EXTRA_HOLD)).rejects.toThrow('The hold doesn’t cover this. Hold more first.')
    await expect(fromApprovedHold(reader(SELLER_C_EXTRA_HOLD))(SELLER_C_EXTRA_HOLD)).resolves.toBeUndefined()
    expect(reads).toEqual([0n, SELLER_C_EXTRA_HOLD])
  })

  test('path 7, gas for the hold wallet: refused with no budget, nothing sent', async () => {
    const { world } = setup({ environment: 'production' })
    const { client, transfers } = fakeGasClient()
    await expect(gasFromBudget(client, world.spend).ensureGas(KEY, WALLET, 1n)).rejects.toThrow(OVER_BUDGET)
    expect(transfers).toEqual([])
  })

  test('path 7, gas for the hold wallet: taken from the approved budget, and refused past it', async () => {
    const { world, store } = await productionBudget(usdc(1))
    const { client, transfers } = fakeGasClient(usdc(0.002), usdc(0.01))
    expect(await gasFromBudget(client, world.spend).ensureGas(KEY, WALLET, 1n)).toBe(usdc(0.008))
    expect(transfers).toEqual([usdc(0.008)])
    expect(store.read().budget?.used).toBe(usdc(0.008).toString())

    // A wallet that already has the gas gets nothing and is charged nothing.
    const full = fakeGasClient(usdc(0.01), usdc(0.01))
    expect(await gasFromBudget(full.client, world.spend).ensureGas(KEY, WALLET, 1n)).toBe(0n)
    expect(full.transfers).toEqual([])

    expect((await approveHold(world, usdc(0.99), '2')).state).toBe('done')
    const late = fakeGasClient(0n, usdc(0.01))
    await expect(gasFromBudget(late.client, world.spend).ensureGas(KEY, WALLET, 1n)).rejects.toThrow(OVER_BUDGET)
    expect(late.transfers).toEqual([])
  })

  test('path 8, gas taken while a hold waits for approval: the hold is checked again before money moves', async () => {
    const { world, hold } = await productionBudget(usdc(1))
    const started = world.startHold(usdc(1))
    world.spend(usdc(0.01))
    const view = await world.complete(started.request.id, proofFor(started, '3', { environment: 'production' }))
    expect(view).toMatchObject({ state: 'closed', message: OVER_BUDGET })
    expect(hold.deposits).toEqual([])
  })
})

describe('the budget is a real budget', () => {
  test('with a 1 USDC budget, a second 0.6 USDC hold is refused', async () => {
    const { world, hold } = await productionBudget(usdc(1))
    expect(await approveHold(world, usdc(0.6), '1')).toMatchObject({ state: 'done', message: 'Held 0.6 USDC for your agent.' })
    expect(world.status().budgetLeft).toBe('0.4')
    expect(() => world.startHold(usdc(0.6))).toThrow(OVER_BUDGET)
    expect(hold.deposits).toEqual([usdc(0.6)])
    // What is left can still be approved.
    expect((await approveHold(world, usdc(0.4), '2')).state).toBe('done')
    expect(world.status().budgetLeft).toBe('0')
  })

  test('a hold the hold service refuses before any deposit gives its room back', async () => {
    const ctx = setup()
    const failing = createWorldService({
      appId: 'app_x',
      rpId: 'rp_x',
      store: ctx.store,
      ports: {
        sign: () => ({ sig: 's', nonce: `0x${randomBytes(4).toString('hex')}`, createdAt: 1, expiresAt: 121 }),
        verify: (result) => Promise.resolve(passed(result, 'staging')),
        createHold: () => Promise.reject(new HoldError('NOT_ENOUGH_BALANCE', 'Your balance is too low for this hold.')),
      },
    })
    const budget = failing.startBudget(usdc(1))
    await failing.complete(budget.request.id, sessionResult(budget))
    const started = failing.startHold(usdc(1))
    expect((await failing.complete(started.request.id, proofFor(started, '3'))).message).toBe('Your balance is too low for this hold.')
    expect(failing.status().budgetLeft).toBe('1')
  })

  test('a budget saved before budgets had their own proof counts as unset', async () => {
    const { world, store } = setup()
    store.write({ budget: { amount: usdc(5).toString(), sessionId: SESSION } as never, request: null, nullifiers: [], lastApproval: null })
    expect(world.status()).toMatchObject({ budgetSet: false, budgetLeft: null })
    expect(() => world.startHold(usdc(1))).toThrow(NOT_APPROVED)
    const fresh = world.startBudget(usdc(1))
    expect((await world.complete(fresh.request.id, sessionResult(fresh))).message).toBe(BUDGET_SET)
    expect(world.status()).toMatchObject({ budgetSet: true, budgetLeft: '1' })
  })
})

describe('the budget proof', () => {
  test('its signal carries the amount and the budget id, so a proof for another amount is refused', async () => {
    const { world, store, verifyCalls } = setup()
    const started = world.startBudget(usdc(1))
    const otherAmount = { ...started, idkit: { ...started.idkit, signal: `budget:5:${started.request.id}` } }
    const view = await world.complete(started.request.id, sessionResult(otherAmount))
    expect(view).toMatchObject({ state: 'closed', message: NOT_APPROVED })
    expect(verifyCalls).toEqual([])
    expect(store.read().budget).toBeNull()
  })

  test('its signal and nullifier are recorded with the budget', async () => {
    const { world, store } = setup()
    const started = world.startBudget(usdc(1))
    expect(started.idkit.signal).toBe(`budget:1:${started.request.id}`)
    await world.complete(started.request.id, sessionResult(started, SESSION, '0xb0d6e7'))
    const record = store.read()
    expect(record.budget).toMatchObject({ id: started.request.id, amount: usdc(1).toString(), nullifier: 'b0d6e7' })
    expect(record.nullifiers).toEqual(['b0d6e7'])
  })

  test('the same budget proof is refused when it is used again', async () => {
    const { world, store, hold } = setup()
    const first = world.startBudget(usdc(1))
    const proof = sessionResult(first, SESSION, '0xb0d6e7')
    expect((await world.complete(first.request.id, proof)).message).toBe(BUDGET_SET)
    const saved = store.read().budget

    // Sent as it is for a new budget: the signal names the old budget id.
    const again = world.startBudget(usdc(1))
    expect((await world.complete(again.request.id, proof)).message).toBe(NOT_APPROVED)

    // Rebuilt for the new budget but with the same nullifier: refused as a reused proof.
    const rebuilt = world.startBudget(usdc(1))
    expect((await world.complete(rebuilt.request.id, sessionResult(rebuilt, SESSION, '0xb0d6e7'))).message).toBe(NOT_APPROVED)

    // Sent for a hold: another signal again.
    const asHold = world.startHold(usdc(1))
    expect((await world.complete(asHold.request.id, { ...proof, nonce: asHold.idkit.rp_context.nonce })).message).toBe(ANOTHER_HOLD)

    expect(store.read().budget).toEqual(saved)
    expect(hold.deposits).toEqual([])
  })

  test('a budget proof with no signal or no nullifier is refused', async () => {
    const { world, store } = setup()
    const noSignal = world.startBudget(usdc(1))
    expect((await world.complete(noSignal.request.id, { ...sessionResult(noSignal), responses: [] })).message).toBe(NOT_APPROVED)
    const noNullifier = world.startBudget(usdc(1))
    const result = sessionResult(noNullifier) as ReturnType<typeof sessionResult> & { responses: Array<Record<string, unknown>> }
    delete result.responses[0].session_nullifier
    expect((await world.complete(noNullifier.request.id, result)).message).toBe(NOT_APPROVED)
    expect(store.read().budget).toBeNull()
  })
})

describe('the session token', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function start() {
    const app = express()
    app.use(express.json())
    const created: bigint[] = []
    mountWorld(app, {
      env: { WORLD_APP_ID: 'app_x', WORLD_RP_ID: 'rp_x', WORLD_SIGNER_KEY: `0x${randomBytes(32).toString('hex')}` },
      dataDir: dir,
      token: TOKEN,
      createHold: (amount) => {
        created.push(amount)
        return Promise.resolve()
      },
    })
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    servers.push(server)
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, created }
  }

  const routes = ['/world/budget', '/world/hold', '/world/requests/x/complete', '/world/requests/x/cancel', '/world/requests/x/use-last-approval']

  for (const route of routes) {
    test(`${route}: 401 without the token, 403 with a wrong one, and nothing changes`, async () => {
      const { base, created } = await start()
      const send = (headers: Record<string, string>) =>
        fetch(`${base}${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ amount: '1' }),
        })
      expect((await send({})).status).toBe(401)
      expect((await send({ [SESSION_HEADER]: 'wrong' })).status).toBe(403)
      expect((await send({ [SESSION_HEADER]: `${TOKEN}x` })).status).toBe(403)
      expect(createWorldStore(dir).read()).toEqual({ budget: null, request: null, nullifiers: [], lastApproval: null })
      expect(created).toEqual([])
    })
  }

  test('the token goes only to a request the browser marks as from the same page', async () => {
    const { base } = await start()
    const ask = (site?: string) => fetch(`${base}/world/session`, { headers: site ? { 'Sec-Fetch-Site': site } : {} })
    expect((await ask()).status).toBe(403)
    expect((await ask('cross-site')).status).toBe(403)
    expect((await ask('same-site')).status).toBe(403)
    const mine = await ask('same-origin')
    expect(mine.status).toBe(200)
    expect(await mine.json()).toEqual({ token: TOKEN })
  })

  test('the status needs no token and never shows it', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/world/status`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(TOKEN)
  })
})

describe('what the verified result must be', () => {
  test('a result that is not protocol 4.0 is refused, for the budget and for a hold', async () => {
    const { world, store } = setup()
    const budget = world.startBudget(usdc(1))
    expect((await world.complete(budget.request.id, { ...sessionResult(budget), protocol_version: '3.0' })).message).toBe(NOT_APPROVED)
    expect(store.read().budget).toBeNull()

    const ok = await withBudget()
    const started = ok.world.startHold(usdc(1))
    for (const version of ['3.0', undefined, 4]) {
      const next = ok.world.startHold(usdc(1))
      const view = await ok.world.complete(next.request.id, proofFor(next, '1', { protocol_version: version }))
      expect(view.message).toBe(NOT_APPROVED)
    }
    expect(started.request.id).toStartWith('hold_')
    expect(ok.hold.deposits).toEqual([])
  })

  test('a credential other than proof_of_human is refused', async () => {
    const { world, hold } = await withBudget()
    for (const identifier of ['selfie', 'passport', undefined]) {
      const started = world.startHold(usdc(1))
      const proof = proofFor(started, '1') as ReturnType<typeof proofFor> & { responses: Array<Record<string, unknown>> }
      proof.responses[0].identifier = identifier
      expect((await world.complete(started.request.id, proof)).message).toBe(NOT_APPROVED)
    }
    const budget = setup()
    const started = budget.world.startBudget(usdc(1))
    const result = sessionResult(started) as ReturnType<typeof sessionResult> & { responses: Array<Record<string, unknown>> }
    result.responses[0].identifier = 'selfie'
    expect((await budget.world.complete(started.request.id, result)).message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('a session nullifier sent as a bare string is taken, and is the same one as in the array form', async () => {
    const { world, hold, store } = await withBudget()
    const first = world.startHold(usdc(1))
    const proof = proofFor(first, '1') as ReturnType<typeof proofFor> & { responses: Array<Record<string, unknown>> }
    proof.responses[0].session_nullifier = '0xabc'
    expect((await world.complete(first.request.id, proof)).state).toBe('done')
    expect(store.read().nullifiers.at(-2)).toBe('abc')

    const second = world.startHold(usdc(1))
    expect((await world.complete(second.request.id, proofFor(second, String(0xabc)))).message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([usdc(1)])
  })
})

describe('found in review', () => {
  test('two answers for one hold that World confirms at the same moment make one hold and charge the budget once', async () => {
    const { world, hold, store, verifyAnswer } = await withBudget({}, usdc(1))
    const started = world.startHold(usdc(1))
    const waiting: Array<() => void> = []
    verifyAnswer.current = (result) => new Promise((resolve) => waiting.push(() => resolve(passed(result))))

    const both = Promise.all([
      world.complete(started.request.id, proofFor(started, '1')),
      world.complete(started.request.id, proofFor(started, '1')),
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const answer of waiting) answer()
    await both

    expect(hold.deposits).toEqual([usdc(1)])
    expect(store.read().budget?.used).toBe(usdc(1).toString())
    expect(store.read().nullifiers.filter((n) => n === '1')).toHaveLength(1)
    expect(() => world.startHold(usdc(0.1))).toThrow(OVER_BUDGET)
  })

  test('every POST the browser marks as from another site is refused, the app\'s own page and non-browser calls pass', async () => {
    const app = express()
    app.use(refuseCrossSite)
    let reached = 0
    app.post('/demo/compare', (_req, res) => void res.json({ n: ++reached }))
    app.get('/balances', (_req, res) => void res.json({ ok: true }))
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const post = (site?: string) => fetch(`${base}/demo/compare`, { method: 'POST', headers: site ? { 'Sec-Fetch-Site': site } : {} })
      expect((await post('cross-site')).status).toBe(403)
      expect((await post('same-site')).status).toBe(403)
      expect((await post('none')).status).toBe(403)
      expect(reached).toBe(0)
      expect((await post('same-origin')).status).toBe(200)
      expect((await post()).status).toBe(200)
      expect((await fetch(`${base}/balances`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(200)
    } finally {
      server.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The selfie check: the check grows with the amount. A small hold needs a unique person. A large one also needs
// that person at the phone right now.

type Built = ReturnType<typeof proofFor> & { responses: Array<Record<string, unknown>> }

describe('the selfie check grows with the amount', () => {
  test('at or below 0.5 USDC only Proof of Human is asked for, and it is enough to hold', async () => {
    const { world, hold, verifyCalls } = await withBudget()
    expect(world.status().selfieAbove).toBe('0.5')
    for (const [amount, nullifier] of [[usdc(0.5), '61'], [usdc(0.1), '62']] as const) {
      const started = world.startHold(amount)
      expect(started.idkit.credentials).toEqual(['proof_of_human'])
      expect(started.request).toMatchObject({ selfie: false })
      const proof = proofFor(started, nullifier)
      expect(proof.responses.map((r) => r.identifier)).toEqual(['proof_of_human'])
      expect(await world.complete(started.request.id, proof)).toMatchObject({ state: 'done', selfie: false })
    }
    // The first hold's leftover covers the second, so only the first is deposited. Both were charged to the budget.
    expect(hold.deposits).toEqual([usdc(0.5)])
    expect(world.status().budgetLeft).toBe('9.4')
    expect(verifyCalls).toHaveLength(2)
  })

  test('above 0.5 USDC Proof of Human and the selfie check are both asked for, each with the hold signal', async () => {
    const { world, hold, store } = await withBudget()
    const started = world.startHold(usdc(0.51))
    expect(started.idkit.credentials).toEqual(['proof_of_human', 'selfie'])
    expect(started.idkit.signal).toBe(`${started.request.id}:0.51`)
    expect(started.request).toMatchObject({ selfie: true, message: WAITING })
    expect(world.status().request).toMatchObject({ selfie: true })
    expect(store.read().request).toMatchObject({ selfie: true })

    const view = await world.complete(started.request.id, proofFor(started, '63'))
    expect(view).toMatchObject({ state: 'done', message: 'Held 0.51 USDC for your agent.', selfie: true })
    expect(hold.deposits).toEqual([usdc(0.51)])
  })

  test('above the line, an approval with Proof of Human only is refused before World is asked, and nothing is held', async () => {
    const { world, hold, verifyCalls, store } = await withBudget()
    const started = world.startHold(usdc(1))
    const proof = proofFor(started, '64') as Built
    proof.responses = proof.responses.filter((r) => r.identifier !== 'selfie')
    expect(await world.complete(started.request.id, proof)).toMatchObject({ state: 'closed', message: SELFIE_NEEDED })
    expect(verifyCalls).toEqual([])
    expect(hold.deposits).toEqual([])
    expect(store.read().budget?.used).toBe('0')
    expect(store.read().nullifiers).not.toContain((64).toString(16))
  })

  test('above the line, World must name the selfie check as passed, whatever its overall success says', async () => {
    const answers: Array<[string, (result: unknown) => VerifyAnswer]> = [
      ['the selfie line failed', () => ({ success: true, environment: 'staging', results: [{ identifier: 'proof_of_human', success: true }, { identifier: 'selfie', success: false }] })],
      ['no selfie line at all', () => ({ success: true, environment: 'staging', results: [{ identifier: 'proof_of_human', success: true }] })],
      ['no lines at all', () => ({ success: true, environment: 'staging' })],
    ]
    for (const [name, answer] of answers) {
      const { world, hold, verifyAnswer } = await withBudget()
      verifyAnswer.current = (result) => Promise.resolve(answer(result))
      const started = world.startHold(usdc(1))
      const view = await world.complete(started.request.id, proofFor(started, '65'))
      expect({ name, message: view.message }).toEqual({ name, message: SELFIE_NEEDED })
      expect(hold.deposits).toEqual([])
    }
  })

  test('a Proof of Human World turned down refuses the hold, even next to a passing selfie check', async () => {
    const { world, hold, verifyAnswer } = await withBudget()
    verifyAnswer.current = () =>
      Promise.resolve({ success: true, environment: 'staging', results: [{ identifier: 'proof_of_human', success: false }, { identifier: 'selfie', success: true }] })
    const started = world.startHold(usdc(1))
    expect((await world.complete(started.request.id, proofFor(started, '66'))).message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('a selfie check from another issuer, a second copy of a credential or an extra one is refused', async () => {
    const { world, hold } = await withBudget()
    const wrongIssuer = world.startHold(usdc(1))
    const proof = proofFor(wrongIssuer, '67') as Built
    proof.responses[1].issuer_schema_id = 1
    expect((await world.complete(wrongIssuer.request.id, proof)).message).toBe(SELFIE_NEEDED)

    const twice = world.startHold(usdc(1))
    const doubled = proofFor(twice, '68') as Built
    doubled.responses.push({ ...doubled.responses[0], session_nullifier: ['69', '777'] })
    expect((await world.complete(twice.request.id, doubled)).message).toBe(NOT_APPROVED)

    const small = world.startHold(usdc(0.2))
    const extra = proofFor(small, '70') as Built
    extra.responses.push(selfieProof(small, '70'))
    expect((await world.complete(small.request.id, extra)).message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('the selfie check spends its own nullifier, so it cannot be used again under a new Proof of Human', async () => {
    const { world, hold, store } = await withBudget()
    const first = world.startHold(usdc(1))
    expect((await world.complete(first.request.id, proofFor(first, '71'))).state).toBe('done')
    expect(store.read().nullifiers.slice(-2)).toEqual([(71).toString(16), BigInt(selfieNullifierFor('71')).toString(16)])

    const second = world.startHold(usdc(2))
    const reused = proofFor(second, '72') as Built
    reused.responses[1].session_nullifier = [selfieNullifierFor('71'), '777']
    expect((await world.complete(second.request.id, reused)).message).toBe(NOT_APPROVED)

    const same = world.startHold(usdc(2))
    const oneForBoth = proofFor(same, '73') as Built
    oneForBoth.responses[1].session_nullifier = ['73', '777']
    expect((await world.complete(same.request.id, oneForBoth)).message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([usdc(1)])
  })

  test('the replay test still reads its own sentence when the new hold asks for a selfie check', async () => {
    const { world, hold } = await withBudget()
    const small = world.startHold(usdc(0.3))
    expect((await world.complete(small.request.id, proofFor(small, '74'))).state).toBe('done')
    const large = world.startHold(usdc(1))
    expect(await world.useLastApproval(large.request.id)).toMatchObject({ state: 'closed', message: ANOTHER_HOLD })
    expect(hold.deposits).toEqual([usdc(0.3)])
  })

  test('credential_unavailable: nothing is held, the budget is untouched and the screen says why in plain words', async () => {
    const { world, hold, store } = await withBudget()
    const started = world.startHold(usdc(1))
    const view = world.cancel(started.request.id, 'credential_unavailable')
    expect(view).toMatchObject({ state: 'closed', message: SELFIE_UNAVAILABLE })
    expect(SELFIE_UNAVAILABLE).toBe(
      'Not approved: this hold needs a selfie check, which World App could not give right now. Nothing was held.',
    )
    expect(world.status().request).toMatchObject({ state: 'closed', message: SELFIE_UNAVAILABLE })
    // A late approval for the closed request changes nothing.
    expect((await world.complete(started.request.id, proofFor(started, '75'))).message).toBe(SELFIE_UNAVAILABLE)
    expect(hold.deposits).toEqual([])
    expect(store.read().budget?.used).toBe('0')
    expect(world.status().budgetLeft).toBe('10')
  })

  test('credential_unavailable on a small hold, or any other reason, reads the usual refusal', async () => {
    const { world, hold } = await withBudget()
    const small = world.startHold(usdc(0.2))
    expect(world.cancel(small.request.id, 'credential_unavailable').message).toBe(NOT_APPROVED)
    const large = world.startHold(usdc(1))
    expect(world.cancel(large.request.id, 'user_rejected').message).toBe(NOT_APPROVED)
    expect(hold.deposits).toEqual([])
  })

  test('WORLD_SELFIE_ABOVE moves the line, unset is 0.5 USDC, and anything that is not an amount refuses to start', () => {
    const base = { WORLD_APP_ID: 'app_x', WORLD_RP_ID: 'rp_x', WORLD_SIGNER_KEY: '0x01' }
    expect(readWorldConfig(base)?.selfieAbove).toBe(usdc(0.5))
    expect(readWorldConfig({ ...base, WORLD_SELFIE_ABOVE: '' })?.selfieAbove).toBe(usdc(0.5))
    expect(readWorldConfig({ ...base, WORLD_SELFIE_ABOVE: '2.25' })?.selfieAbove).toBe(usdc(2.25))
    expect(readWorldConfig({ ...base, WORLD_SELFIE_ABOVE: '0' })?.selfieAbove).toBe(0n)
    for (const wrong of ['abc', '-1', '0.5 USDC', '1.0000001']) {
      expect(() => readWorldConfig({ ...base, WORLD_SELFIE_ABOVE: wrong })).toThrow('WORLD_SELFIE_ABOVE')
    }
  })

  test('over HTTP: the line from the environment picks the credentials, and the cancel reason reaches the backend', async () => {
    const servers: Server[] = []
    try {
      const open = async (extra: Record<string, string>) => {
        const app = express()
        app.use(express.json())
        const hold = fakeHoldPorts()
        const holds = createHoldService(hold.ports, createHoldStore(dir))
        mountWorld(app, {
          env: { WORLD_APP_ID: 'app_x', WORLD_RP_ID: 'rp_x', WORLD_SIGNER_KEY: `0x${randomBytes(32).toString('hex')}`, ...extra },
          dataDir: mkdtempSync(path.join(dir, 'selfie-')),
          token: TOKEN,
          createHold: (amount) => holds.start(amount),
          fetchImpl: passingFetch('staging'),
        })
        const server = await new Promise<Server>((resolve) => {
          const s = app.listen(0, '127.0.0.1', () => resolve(s))
        })
        servers.push(server)
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const post = async (route: string, body: unknown = {}) =>
          (await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: TOKEN },
            body: JSON.stringify(body),
          })).json()
        const budget = (await post('/world/budget', { amount: '5' })) as Started
        expect(await post(`/world/requests/${budget.request.id}/complete`, { result: sessionResult(budget) })).toMatchObject({ message: BUDGET_SET })
        return { post, hold, base }
      }

      const usual = await open({})
      expect(await (await fetch(`${usual.base}/world/status`)).json()).toMatchObject({ selfieAbove: '0.5' })
      const large = (await usual.post('/world/hold', { amount: '1.5' })) as Started
      expect(large.idkit.credentials).toEqual(['proof_of_human', 'selfie'])
      expect(await usual.post(`/world/requests/${large.request.id}/cancel`, { reason: 'credential_unavailable' })).toMatchObject({
        state: 'closed',
        message: SELFIE_UNAVAILABLE,
      })
      const again = (await usual.post('/world/hold', { amount: '1.5' })) as Started
      expect(await usual.post(`/world/requests/${again.request.id}/complete`, { result: proofFor(again, '76') })).toMatchObject({
        state: 'done',
        message: 'Held 1.5 USDC for your agent.',
      })
      expect(usual.hold.deposits).toEqual([usdc(1.5)])

      const raised = await open({ WORLD_SELFIE_ABOVE: '2' })
      const below = (await raised.post('/world/hold', { amount: '1.5' })) as Started
      expect(below.idkit.credentials).toEqual(['proof_of_human'])
    } finally {
      for (const server of servers) server.close()
    }
  })
})
