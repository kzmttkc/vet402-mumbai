import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Address } from 'viem'
import {
  BALANCE_CHECK_NAME,
  BALANCE_CHECK_RESOURCE,
  balanceCheckCandidate,
  balanceFromCircle,
  describeBalance,
  gatewayBalance,
} from '../balanceCheckSeller'
import { toCandidate } from '../discovery'
import type { Candidate } from '../discovery'
import { PAYMENT_CHECK_NAME, paymentCheckCandidate } from '../paymentCheckSeller'
import type { OwnPurchase } from '../paymentCheckSeller'
import { DEMO_PRICE } from '../sellers'
import { createTryJob, limitLine, PROTECTED_LINE, TRY_JOB_LIMIT } from '../tryJob'
import type { TryJobPorts, TryPlanView } from '../tryJob'

// vet402 Balance Check beside vet402 Payment Check and Circle's Arc catalog, the file read on 2026-11-06.
// Circle is a fake fetch, so nothing here reaches a real network.

const NETWORK = 'eip155:5042002'
const TX = `0x${'ab'.repeat(32)}`
const TRANSFER_ID = '0b7c4f3e-1a2b-4c3d-8e9f-0123456789ab'
const SELLER: Address = '0x00000000000000000000000000000000000000a1'
const SEALED: Address = '0x00000000000000000000000000000000000000c1'
const AGENT = '0xd31289Fb26EF43CBF79ACf95b58ae92Ec2Dc01d7'

const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures/arc-discovery-2026-11-06.json'), 'utf8')) as {
  items: Parameters<typeof toCandidate>[0][]
}
const catalog: Candidate[] = raw.items.flatMap((item) => {
  const c = toCandidate(item, NETWORK)
  return c ? [c] : []
})

const purchase = (data: string): OwnPurchase => ({
  data,
  paid: DEMO_PRICE,
  nonce: `0x${'ee'.repeat(32)}`,
  timesReceived: 1,
  transaction: TRANSFER_ID,
  lines: ['Answer received and checked. You paid 0.001 USDC once.'],
})

const BALANCE_SUMMARY = "Reads your agent's Circle Gateway balance and sends the answer sealed on Arc."
const BALANCE_ANSWER = 'Your agent has 0.9839 USDC left to spend after this check, in its Circle Gateway balance on Arc.'

function setup(covers?: boolean | null, limit?: bigint) {
  const bought: string[] = []
  const ports: TryJobPorts = {
    candidates: () => Promise.resolve(catalog),
    latestReceipt: () => Promise.resolve({ batchTx: TX }),
    holdAvailable: () => Promise.resolve(1_000_000n),
    pay: () => Promise.reject(new Error('the catalog route is not used here')),
    findTransfer: () => Promise.resolve({ id: TRANSFER_ID, status: 'received', txHash: null }),
    ownTransfer: () => Promise.resolve(null),
    recentPayments: () => Promise.resolve([]),
    ownSellers: [
      {
        candidate: paymentCheckCandidate(SELLER, SEALED),
        buy: () => {
          bought.push(PAYMENT_CHECK_NAME)
          return Promise.resolve(purchase("Yes, your agent's last payment went through."))
        },
      },
      {
        candidate: balanceCheckCandidate(SELLER, SEALED),
        summary: BALANCE_SUMMARY,
        buy: () => {
          bought.push(BALANCE_CHECK_NAME)
          return Promise.resolve(purchase(BALANCE_ANSWER))
        },
      },
    ],
    ...(covers === undefined ? {} : { coverage: (c: Candidate) => Promise.resolve(c.sealedBy ? covers : null) }),
    log: () => {},
  }
  return { service: createTryJob(ports, { secret: 'test secret', now: () => 1_800_000_000_000, ...(limit ? { limit } : {}) }), bought }
}

async function planOf(service: ReturnType<typeof createTryJob>, job: string): Promise<TryPlanView> {
  const reply = await service.plan(job, '203.0.113.7')
  if (!reply.ok || !reply.value.ok) throw new Error('expected a plan')
  return reply.value.plan
}

describe('vet402 Balance Check, the listing', () => {
  test('is built the same way as Payment Check: the same seller wallet, contract, price and mark', () => {
    const balance = balanceCheckCandidate(SELLER, SEALED)
    const payment = paymentCheckCandidate(SELLER, SEALED)
    expect(balance.sellerName).toBe(BALANCE_CHECK_NAME)
    expect(balance.resource).toBe(BALANCE_CHECK_RESOURCE)
    expect(balance.own).toBe(true)
    for (const field of ['payTo', 'sealedBy', 'amount', 'method'] as const) expect(balance[field]).toEqual(payment[field])
    expect(balance.path).toBe('/balance-check')
  })
})

describe('the answer', () => {
  test('says in plain words what the agent can spend once this check is paid', () => {
    // The seller reads the balance before it settles the check, so the check's own 0.001 USDC is taken off.
    expect(describeBalance(984_900n, DEMO_PRICE)).toBe('Your agent has 0.9839 USDC left to spend after this check, in its Circle Gateway balance on Arc.')
    expect(describeBalance(DEMO_PRICE, DEMO_PRICE)).toBe('Your agent has no USDC left to spend after this check. Its Circle Gateway balance on Arc is empty.')
    expect(describeBalance(0n, DEMO_PRICE)).toBe('Your agent has no USDC left to spend after this check. Its Circle Gateway balance on Arc is empty.')
  })

  test("reads Circle Gateway's balance for the payer, on Arc's domain, by address only", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetchImpl = ((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const body = { token: 'USDC', balances: [{ domain: 26, depositor: AGENT, balance: '0.984900', pendingBatch: '0' }] }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }) as typeof fetch
    expect(await gatewayBalance(AGENT, fetchImpl)).toBe(984_900n)
    expect(await balanceFromCircle(AGENT, DEMO_PRICE, fetchImpl)).toBe(
      'Your agent has 0.9839 USDC left to spend after this check, in its Circle Gateway balance on Arc.',
    )
    expect(calls[0]!.url).toBe('https://gateway-api-testnet.circle.com/v1/balances')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ token: 'USDC', sources: [{ depositor: AGENT, domain: 26 }] })
  })

  test('a failed or empty read throws, so the seller seals nothing and the buyer is not charged', async () => {
    const answer = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch
    await expect(gatewayBalance(AGENT, answer(500, {}))).rejects.toThrow('status 500')
    await expect(gatewayBalance(AGENT, answer(200, { balances: [] }))).rejects.toThrow('no balance')
    await expect(gatewayBalance(AGENT, answer(200, { balances: [{ domain: 6, balance: '1' }] }))).rejects.toThrow('no balance')
  })
})

describe('the agent ranks vet402 Balance Check beside Payment Check and the catalog', () => {
  for (const job of ['How much USDC does my agent have?', "What is my agent's balance?"]) {
    test(`"${job}" picks Balance Check, with its own sentence, the mark and the protection line`, async () => {
      const { service } = setup(true)
      const plan = await planOf(service, job)
      expect(plan.sellerName).toBe(BALANCE_CHECK_NAME)
      expect(plan.own).toBe(true)
      expect(plan.summary).toBe(BALANCE_SUMMARY)
      expect(plan.protection).toBe(PROTECTED_LINE)
      expect(plan.compared[0]).toEqual({ sellerName: BALANCE_CHECK_NAME, listing: 'balance-check', amount: '0.001', note: 'Picked', own: true })
      expect(plan.why).toContain("Picked from 134 Arc listings and vet402's own seller")
    })
  }

  test('no protection line when the deposit read is false, as for Payment Check', async () => {
    const { service } = setup(false)
    const reply = await service.plan('How much USDC does my agent have?', '203.0.113.7')
    const plan = reply.ok && reply.value.ok ? reply.value.plan : null
    expect(plan?.protection).toBeUndefined()
    expect(plan?.sellerName).not.toBe(BALANCE_CHECK_NAME)
  })

  test('approving it buys Balance Check from vet402 itself, and only it', async () => {
    const { service, bought } = setup(true)
    const job = 'How much USDC does my agent have?'
    const plan = await planOf(service, job)
    const reply = await service.approve(job, plan.id, '203.0.113.7')
    if (!reply.ok) throw new Error(`expected a payment, got ${reply.code}`)
    expect(bought).toEqual([BALANCE_CHECK_NAME])
    expect(reply.value.text).toBe(BALANCE_ANSWER)
    expect(reply.value.lines).toEqual(['Answer received and checked. You paid 0.001 USDC once.'])
  })
})

describe('the three examples on the page pick as before, with Balance Check in the pool', () => {
  test('"Did my last payment go through?" still ranks Payment Check first, then Quicknode and BotPay', async () => {
    for (const covers of [undefined, true]) {
      const { service } = setup(covers)
      const plan = await planOf(service, 'Did my last payment go through?')
      expect(plan.sellerName).toBe(PAYMENT_CHECK_NAME)
      expect(plan.compared.map((c) => `${c.sellerName} ${c.note}`)).toEqual([
        `${PAYMENT_CHECK_NAME} Picked`,
        'Quicknode Lower match',
        'BotPay Only a payment word matched',
      ])
    }
  })

  test('"Get me a paid access receipt" still picks BotPay', async () => {
    const { service } = setup(true)
    const plan = await planOf(service, 'Get me a paid access receipt')
    expect(plan.sellerName).toBe('BotPay')
    expect(plan.own).toBeUndefined()
    // The two BotPay listings score the same. The cheaper one stays first, as it was before Balance Check joined the pool.
    expect(plan.compared.map((c) => `${c.sellerName} ${c.listing} ${c.note}`)).toEqual([
      'BotPay pay Picked',
      'BotPay go Over the limit',
      'Quicknode arc-testnet Lower match',
    ])
  })

  test('"What\'s the weather in Mumbai?" still finds nobody and pays nothing', async () => {
    const { service, bought } = setup(true)
    const reply = await service.plan("What's the weather in Mumbai?", '203.0.113.7')
    expect(reply.ok && !reply.value.ok ? reply.value.code : null).toBe('NO_SELLER')
    expect(bought).toEqual([])
  })
})

describe('the limit line on the approval card', () => {
  test('comes from the limit the agent keeps to, not from a fixed text', async () => {
    expect(limitLine(TRY_JOB_LIMIT)).toBe('Each job can spend at most 0.01 USDC.')
    const { service } = setup(true)
    expect((await planOf(service, 'Did my last payment go through?')).limitLine).toBe('Each job can spend at most 0.01 USDC.')
    const lower = setup(true, 5_000n).service
    expect((await planOf(lower, 'Did my last payment go through?')).limitLine).toBe('Each job can spend at most 0.005 USDC.')
  })
})
