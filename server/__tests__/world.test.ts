import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { hashSignal } from '@worldcoin/idkit-core/hashing'
import { createHoldService, HoldError } from '../hold'
import type { HoldPorts } from '../hold'
import { createHoldStore } from '../holdStore'
import {
  ANOTHER_HOLD,
  BUDGET_SET,
  createWorldPorts,
  createWorldService,
  NOT_APPROVED,
  readWorldConfig,
  WAITING,
  WorldError,
} from '../world'
import type { IdkitParams, VerifyAnswer } from '../world'
import { mountWorld } from '../worldRoutes'
import { createWorldStore } from '../worldStore'

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

function setup(options: { ttlMs?: number } = {}) {
  const clock = { now: 1_000_000 }
  const hold = fakeHoldPorts()
  const holds = createHoldService(hold.ports, createHoldStore(dir))
  const verifyCalls: unknown[] = []
  const verifyAnswer: { current: () => Promise<VerifyAnswer> } = {
    current: () => Promise.resolve({ success: true, environment: 'staging' }),
  }
  let signs = 0
  const store = createWorldStore(dir)
  const world = createWorldService({
    appId: 'app_staging_test',
    rpId: 'rp_test',
    store,
    now: () => clock.now,
    ttlMs: options.ttlMs,
    ports: {
      sign: () => {
        signs += 1
        return { sig: `sig-${signs}`, nonce: `0x${signs.toString(16).padStart(4, '0')}`, createdAt: 10, expiresAt: 130 }
      },
      verify: (result) => {
        verifyCalls.push(result)
        return verifyAnswer.current()
      },
      createHold: (amount) => holds.start(amount),
    },
  })
  return { world, clock, hold, verifyCalls, verifyAnswer, store }
}

type Started = { request: { id: string }; idkit: IdkitParams }

function sessionResult(started: Started, sessionId = SESSION) {
  return { protocol_version: '4.0', nonce: started.idkit.rp_context.nonce, environment: 'staging', session_id: sessionId, responses: [] }
}

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
    expect(() => world.startHold(usdc(5.01))).toThrow(NOT_APPROVED)
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
    expect(started.idkit.signal).toBeUndefined()

    const result = sessionResult(started)
    const view = await world.complete(started.request.id, result)

    expect(view).toMatchObject({ state: 'done', message: BUDGET_SET })
    expect(verifyCalls).toEqual([result])
    expect(store.read().budget).toEqual({ amount: usdc(10).toString(), sessionId: SESSION })
    expect(world.status().budgetSet).toBe(true)
  })

  test('a saved session id is never replaced', async () => {
    const { world, store } = await withBudget()
    expect(() => world.startBudget(usdc(20))).toThrow(NOT_APPROVED)
    expect(store.read().budget?.sessionId).toBe(SESSION)
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
    expect(store.read().request?.jobId).toStartWith('job_')
    expect(started.idkit.session_id).toBe(SESSION)
    expect(started.idkit.signal).toBe(`${started.request.id}:1.5`)

    const view = await world.complete(started.request.id, proofFor(started, '99'))

    expect(view).toMatchObject({ state: 'done', message: 'Held 1.5 USDC for this job.' })
    expect(hold.deposits).toEqual([usdc(1.5)])
    expect(store.read().nullifiers).toEqual([(99).toString(16)])
  })

  test('the same person approves a second hold with a new nullifier', async () => {
    const { world, hold } = await withBudget()
    const first = world.startHold(usdc(1))
    expect((await world.complete(first.request.id, proofFor(first, '1'))).state).toBe('done')

    const second = world.startHold(usdc(2))
    const view = await world.complete(second.request.id, proofFor(second, '2'))

    expect(view.message).toBe('Held 2 USDC for this job.')
    // The first hold's leftover stays, so the second deposit is only the difference.
    expect(hold.deposits).toEqual([usdc(1), usdc(1)])
  })

  test('a hold that fails after approval keeps the nullifier spent and shows the hold error', async () => {
    const { world, hold, store } = await withBudget()
    hold.state.depositFails = true
    const started = world.startHold(usdc(1))

    const view = await world.complete(started.request.id, proofFor(started, '7'))

    expect(view).toMatchObject({ state: 'closed', message: 'The hold could not be set up. Please try again.' })
    expect(store.read().nullifiers).toEqual(['7'])
  })

  test('a balance too low shows the existing sentence', async () => {
    const ctx = setup()
    const failing = createWorldService({
      appId: 'app_x',
      rpId: 'rp_x',
      store: ctx.store,
      ports: {
        sign: () => ({ sig: 's', nonce: `0x${randomBytes(4).toString('hex')}`, createdAt: 1, expiresAt: 121 }),
        verify: () => Promise.resolve({ success: true, environment: 'staging' }),
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
        verify: () => Promise.resolve({ success: true, environment: 'staging' }),
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
    for (const value of [SESSION, 'feedface', started.idkit.rp_context.nonce, started.idkit.rp_context.signature, 'job_']) {
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

  async function listen(env: Record<string, string | undefined>, verifyBody: unknown = { success: true, environment: 'staging' }) {
    const hold = fakeHoldPorts()
    const holds = createHoldService(hold.ports, createHoldStore(dir))
    const app = express()
    app.use(express.json())
    const worldOn = mountWorld(app, {
      env,
      dataDir: dir,
      createHold: (amount) => holds.start(amount),
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify(verifyBody)))) as unknown as typeof fetch,
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
    const post = (route: string, body: unknown = {}) =>
      fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { hold, worldOn, base, post }
  }

  const fullEnv = () => ({
    WORLD_APP_ID: 'app_staging_x',
    WORLD_RP_ID: 'rp_x',
    WORLD_SIGNER_KEY: `0x${randomBytes(32).toString('hex')}`,
  })

  test('without the variables the hold stays as it is today and nothing is written', async () => {
    const { hold, worldOn, base, post } = await listen({})

    expect(worldOn).toBe(false)
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
    expect(await held.json()).toMatchObject({ state: 'done', message: 'Held 2 USDC for this job.' })
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
