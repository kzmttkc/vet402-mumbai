import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { toCandidate } from '../discovery'
import type { Candidate } from '../discovery'
import type { TransferInfo } from '../jobs'
import type { PlannedRequest } from '../planner'
import { createTryJob, createTryJobHandler, JOB_DAY_MS, JOB_IP_GAP_MS, PLAN_TTL_MS, TRY_JOB_MESSAGES } from '../tryJob'
import type { TryJobPorts } from '../tryJob'
import { tryJobFromEnv } from '../tryJobWire'

// The public agent against fakes: the real Arc catalog from a file, and a payment that is only
// recorded. No chain, no Gateway, no Circle. A real run needs TRY_JOB_HOLD_KEY on the host.

const TX = `0x${'ab'.repeat(32)}`
const BATCH = `0x${'cd'.repeat(32)}`
const TRANSFER_ID = '0b7c4f3e-1a2b-4c3d-8e9f-0123456789ab'

const raw = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/arc-discovery-2026-11-06.json'), 'utf8'),
) as { items: Parameters<typeof toCandidate>[0][] }
const catalog: Candidate[] = raw.items.flatMap((item) => {
  const c = toCandidate(item, 'eip155:5042002')
  return c ? [c] : []
})

interface Setup {
  available?: bigint
  recent?: number[]
  payFails?: boolean
  clock?: { t: number }
  dailyLimit?: number
}

function setup(over: Setup = {}) {
  const clock = over.clock ?? { t: 1_800_000_000_000 }
  const paid: { request: PlannedRequest; cap: bigint }[] = []
  const transfers = new Map<string, TransferInfo>([[TRANSFER_ID, { id: TRANSFER_ID, status: 'completed', txHash: BATCH }]])
  const ports: TryJobPorts = {
    candidates: () => Promise.resolve(catalog),
    latestReceipt: () => Promise.resolve({ batchTx: TX }),
    holdAvailable: () => Promise.resolve(over.available ?? 1_000_000n),
    pay: (request, cap) => {
      if (over.payFails) return Promise.reject(new Error('seller said no'))
      paid.push({ request, cap })
      return Promise.resolve({ data: { result: { status: '0x1' } }, paid: cap, nonce: `0x${'ee'.repeat(32)}`, timesReceived: 1, transaction: '' })
    },
    findTransfer: () => Promise.resolve({ id: TRANSFER_ID, status: 'received', txHash: null }),
    ownTransfer: (id) => Promise.resolve(transfers.get(id) ?? null),
    recentPayments: () => Promise.resolve(over.recent ?? []),
    log: () => {},
  }
  const service = createTryJob(ports, { secret: 'test secret', now: () => clock.t, dailyLimit: over.dailyLimit ?? 40 })
  const handle = createTryJobHandler(() => service)
  return { ports, paid, clock, service, handle }
}

const post = (body: unknown, ip = '203.0.113.7') =>
  new Request('https://vet402.example/api/try-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  })

const get = (query: string, ip = '203.0.113.7') =>
  new Request(`https://vet402.example/api/try-job?${query}`, { headers: { 'x-real-ip': ip } })

async function planned(handle: (r: Request) => Promise<Response>, job: string) {
  const res = await handle(post({ step: 'plan', job }))
  expect(res.status).toBe(200)
  return (await res.json()) as { ok: boolean; plan: { id: string; sellerName: string; amount: string; why: string; covered: boolean } }
}

const PAYMENT_JOB = 'Did my last payment go through?'

describe('Ask the agent, on the public page', () => {
  test('with no key it rests, for every request', async () => {
    const handle = createTryJobHandler(() => null)
    for (const req of [post({ step: 'plan', job: PAYMENT_JOB }), get(`transfer=${TRANSFER_ID}`)]) {
      const res = await handle(req)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ code: 'RESTING', error: TRY_JOB_MESSAGES.RESTING })
    }
  })

  test('the key comes from its own variable only, and never the dispute wallet', () => {
    const key = `0x${'11'.repeat(32)}`
    expect(tryJobFromEnv({})).toBeNull()
    expect(tryJobFromEnv({ TRY_JOB_HOLD_KEY: 'not a key' })).toBeNull()
    expect(tryJobFromEnv({ TRY_HOLD_KEY: key })).toBeNull()
    expect(tryJobFromEnv({ TRY_JOB_HOLD_KEY: key, TRY_HOLD_KEY: key })).toBeNull()
  })

  test('planning shows the pick and why, and pays nothing', async () => {
    const { handle, paid } = setup()
    const body = await planned(handle, PAYMENT_JOB)
    expect(body.ok).toBe(true)
    expect(body.plan.sellerName).toBe('Quicknode')
    expect(body.plan.amount).toBe('0.0001')
    expect(body.plan.why).toBe("Picked from 134 Arc listings: best match for 'payment', 0.0001 USDC")
    expect(body.plan.covered).toBe(true)
    expect(paid).toHaveLength(0)
  })

  test('approving pays the planned seller once, capped at the planned amount', async () => {
    const { handle, paid } = setup()
    const { plan } = await planned(handle, PAYMENT_JOB)
    const res = await handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      sellerName: 'Quicknode',
      text: 'Yes, your payment went through.',
      paid: '0.0001',
      transferId: TRANSFER_ID,
      status: 'received',
      batchTx: null,
    })
    expect(paid).toEqual([
      {
        request: {
          url: 'https://x402.quicknode.com/arc-testnet/',
          method: 'POST',
          body: { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [TX] },
        },
        cap: 100n,
      },
    ])
  })

  test('an amount, a payee or a URL from the browser is never read', async () => {
    const { handle, paid } = setup()
    const { plan } = await planned(handle, PAYMENT_JOB)
    const res = await handle(
      post({
        step: 'approve',
        job: PAYMENT_JOB,
        id: plan.id,
        amount: '5',
        cap: '5000000',
        payTo: '0x000000000000000000000000000000000000dEaD',
        url: 'https://evil.example/pay',
        request: { url: 'https://evil.example/pay', method: 'GET' },
      }),
    )
    expect(res.status).toBe(200)
    expect(paid).toHaveLength(1)
    expect(paid[0]?.cap).toBe(100n)
    expect(paid[0]?.request.url).toBe('https://x402.quicknode.com/arc-testnet/')
  })

  test('a different question picks a different seller', async () => {
    const { handle, paid } = setup()
    const job = 'Get me a paid access receipt'
    const { plan } = await planned(handle, job)
    expect(plan.sellerName).toBe('BotPay')
    expect(plan.amount).toBe('0.01')
    await handle(post({ step: 'approve', job, id: plan.id }))
    expect(paid[0]?.request).toEqual({ url: 'https://api.botpay.network/pay', method: 'GET' })
    expect(paid[0]?.cap).toBe(10_000n)
  })

  test('with nobody to do the job it says why, and pays nothing', async () => {
    const { handle, paid } = setup()
    const res = await handle(post({ step: 'plan', job: "What's the weather in Mumbai?" }))
    expect(await res.json()).toEqual({
      ok: false,
      code: 'NO_SELLER',
      message: 'I couldn’t find anyone who can do this job. None of the 134 Arc listings matched. Nothing was paid.',
      compared: [],
    })
    expect(paid).toHaveLength(0)
  })

  test('one paid job every two minutes from the same address', async () => {
    const { handle, paid, clock } = setup()
    const pay = async (ip: string) => {
      const { plan } = await planned(handle, PAYMENT_JOB)
      return handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id }, ip))
    }
    expect((await pay('198.51.100.1')).status).toBe(200)
    const again = await pay('198.51.100.1')
    expect(again.status).toBe(429)
    expect(((await again.json()) as { code: string }).code).toBe('RATE')
    expect((await pay('198.51.100.2')).status).toBe(200)
    clock.t += JOB_IP_GAP_MS
    expect((await pay('198.51.100.1')).status).toBe(200)
    expect(paid).toHaveLength(3)
  })

  test("the day's limit counts Circle's record, so every instance shares it", async () => {
    const clock = { t: 1_800_000_000_000 }
    const { handle, paid } = setup({ clock, dailyLimit: 2, recent: [clock.t - 1000, clock.t - JOB_DAY_MS / 2] })
    const { plan } = await planned(handle, PAYMENT_JOB)
    const res = await handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id }))
    expect(res.status).toBe(429)
    expect(((await res.json()) as { code: string }).code).toBe('DAILY')
    expect(paid).toHaveLength(0)
  })

  test('a changed id, other words, or an old card pays nothing', async () => {
    const { handle, paid, clock } = setup()
    const { plan } = await planned(handle, PAYMENT_JOB)
    const forged = `${plan.id.slice(0, -1)}${plan.id.endsWith('0') ? '1' : '0'}`
    expect((await handle(post({ step: 'approve', job: PAYMENT_JOB, id: forged }))).status).toBe(409)
    expect((await handle(post({ step: 'approve', job: 'Get me a paid access receipt', id: plan.id }))).status).toBe(409)
    clock.t += PLAN_TTL_MS + 1
    expect((await handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id }))).status).toBe(409)
    expect((await handle(post({ step: 'approve', job: PAYMENT_JOB, id: 'nonsense' }))).status).toBe(400)
    expect(paid).toHaveLength(0)
  })

  test('an empty test wallet shows the card but pays nothing', async () => {
    const { handle, paid } = setup({ available: 0n })
    const { plan } = await planned(handle, PAYMENT_JOB)
    expect(plan.covered).toBe(false)
    const res = await handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id }))
    expect(res.status).toBe(503)
    expect(paid).toHaveLength(0)
  })

  test('a failed payment says so without details', async () => {
    const { handle } = setup({ payFails: true })
    const { plan } = await planned(handle, PAYMENT_JOB)
    const res = await handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id }))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ code: 'PAY_FAILED', error: TRY_JOB_MESSAGES.PAY_FAILED })
  })

  test('the settlement check reads only the agent’s own payments, and not too often', async () => {
    const { handle, clock } = setup()
    const ok = await handle(get(`transfer=${TRANSFER_ID}`))
    expect(await ok.json()).toEqual({ status: 'completed', batchTx: BATCH })
    expect((await handle(get(`transfer=${TRANSFER_ID}`))).status).toBe(429)
    clock.t += 5_000
    expect((await handle(get('transfer=1f00aa00-0000-4000-8000-000000000000'))).status).toBe(404)
    clock.t += 5_000
    expect((await handle(get('transfer=../../etc'))).status).toBe(400)
  })

  test('planning is free, but one address gets at most 10 plans a minute', async () => {
    const { handle, clock, paid } = setup()
    for (let i = 0; i < 10; i++) expect((await handle(post({ step: 'plan', job: PAYMENT_JOB }))).status).toBe(200)
    expect((await handle(post({ step: 'plan', job: PAYMENT_JOB }))).status).toBe(429)
    expect((await handle(post({ step: 'plan', job: PAYMENT_JOB }, '198.51.100.9'))).status).toBe(200)
    clock.t += 60_000
    expect((await handle(post({ step: 'plan', job: PAYMENT_JOB }))).status).toBe(200)
    expect(paid).toHaveLength(0)
  })

  test('a job is plain words of at most 500 characters', async () => {
    const { handle } = setup()
    expect((await handle(post({ step: 'plan', job: 'x'.repeat(501) }))).status).toBe(400)
    expect((await handle(post({ step: 'plan', job: 42 }))).status).toBe(400)
    expect((await handle(post({ step: 'pay', job: PAYMENT_JOB }))).status).toBe(400)
  })
})
