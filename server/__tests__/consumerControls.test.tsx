import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { LimitRow, PurchaseList } from '../../src/components/AgentControls'
import { DroppedLineLink, SealedLines, SpendQuestion } from '../../src/components/AskAgent'
import { PublicApp } from '../../src/PublicApp'
import { addPurchase, DEFAULT_LIMIT, LIMIT_CHOICES, loadLimit, loadPurchases, MAX_PURCHASES, saveLimit } from '../../src/lib/agentHistory'
import type { KeyStore, Purchase } from '../../src/lib/agentHistory'
import { receiptLine } from '../../src/lib/askAgent'
import { formatUsdc } from '../../src/onchain-money'
import { BALANCE_CHECK_NAME, balanceCheckCandidate } from '../balanceCheckSeller'
import { toCandidate } from '../discovery'
import type { Candidate } from '../discovery'
import { createPaymentCheck, DELIVERED_FROM_ARC, LINE_DROPPED_ANSWERED, PAYMENT_CHECK_NAME, paymentCheckCandidate } from '../paymentCheckSeller'
import type { OwnPurchase } from '../paymentCheckSeller'
import type { PlannedRequest } from '../planner'
import { claimIdOf, createSealedDelivery, createSealedPorts } from '../sealedDelivery'
import type { ClaimLinks, SealedBox } from '../sealedDelivery'
import { DEMO_PRICE } from '../sellers'
import type { SellerFacilitator } from '../sellers'
import { cleanLimit, createTryJob, createTryJobHandler, JOB_IP_GAP_MS, limitLine, OVER_YOUR_LIMIT_NOTE, PROTECTED_LINE, TRY_JOB_LIMIT } from '../tryJob'
import type { PaidReply, TryJobPorts, TryPlanView } from '../tryJob'

// The person's controls on "Ask the agent": a limit per job that the server keeps to, the list of what the agent bought
// in this browser, and the dropped line tried on purpose. The catalog is the file read on 2026-11-06, the chain is an
// in-memory fake, and Gateway is a fake facilitator, so nothing here reaches a real network.

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).__ARKIV_WRITER__ = ''
})

const NETWORK = 'eip155:5042002'
const TX = `0x${'ab'.repeat(32)}`
const TRANSFER_ID = '0b7c4f3e-1a2b-4c3d-8e9f-0123456789ab'
const SELLER: Address = '0x00000000000000000000000000000000000000a1'
const SEALED: Address = '0x00000000000000000000000000000000000000c1'

const PAYMENT_JOB = 'Did my last payment go through?'
const RECEIPT_JOB = 'Get me a paid access receipt'
const WEATHER_JOB = "What's the weather in Mumbai?"
const BALANCE_JOB = 'How much USDC does my agent have?'

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

/** The public agent with both of vet402's own sellers beside the catalog, as the deploy has it. */
function setup({ covers = true }: { covers?: boolean } = {}) {
  const bought: { name: string; cap: bigint; lineDropped: boolean }[] = []
  const paid: { request: PlannedRequest; cap: bigint }[] = []
  const clock = { t: 1_800_000_000_000 }
  const own = (candidate: Candidate, answer: string) => ({
    candidate,
    buy: (cap: bigint, options?: { lineDropped?: boolean }) => {
      bought.push({ name: candidate.sellerName, cap, lineDropped: options?.lineDropped === true })
      return Promise.resolve(purchase(answer))
    },
  })
  const ports: TryJobPorts = {
    candidates: () => Promise.resolve(catalog),
    latestReceipt: () => Promise.resolve({ batchTx: TX }),
    holdAvailable: () => Promise.resolve(1_000_000n),
    pay: (request, cap) => {
      paid.push({ request, cap })
      return Promise.resolve({ data: { result: { status: '0x1' } }, paid: cap, nonce: null, timesReceived: 1, transaction: TRANSFER_ID })
    },
    findTransfer: () => Promise.resolve({ id: TRANSFER_ID, status: 'received', txHash: null }),
    ownTransfer: () => Promise.resolve(null),
    recentPayments: () => Promise.resolve([]),
    ownSellers: [
      own(paymentCheckCandidate(SELLER, SEALED), "Yes, your agent's last payment went through."),
      own(balanceCheckCandidate(SELLER, SEALED), 'Your agent has 0.9839 USDC left to spend after this check.'),
    ],
    coverage: (c: Candidate) => Promise.resolve(c.sealedBy ? covers : null),
    log: () => {},
  }
  const service = createTryJob(ports, { secret: 'test secret', now: () => clock.t })
  return { service, handle: createTryJobHandler(() => service), bought, paid, clock }
}

const post = (body: unknown, ip = '203.0.113.7') =>
  new Request('https://vet402.example/api/try-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  })

type PlanBody = { ok: true; plan: TryPlanView } | { ok: false; code: string; message: string; compared: { sellerName: string; note: string }[] }

async function planBody(handle: (r: Request) => Promise<Response>, job: string, limit?: string): Promise<PlanBody> {
  const res = await handle(post({ step: 'plan', job, ...(limit === undefined ? {} : { limit }) }))
  expect(res.status).toBe(200)
  return (await res.json()) as PlanBody
}

async function planOf(handle: (r: Request) => Promise<Response>, job: string, limit?: string): Promise<TryPlanView> {
  const body = await planBody(handle, job, limit)
  if (!body.ok) throw new Error(`expected a plan, got ${body.code}`)
  return body.plan
}

describe('the limit the person picks', () => {
  test('comes from the browser only as a positive USDC amount, and never above the server limit', () => {
    expect(cleanLimit(undefined, TRY_JOB_LIMIT)).toBe(TRY_JOB_LIMIT)
    expect(cleanLimit('0.001', TRY_JOB_LIMIT)).toBe(1_000n)
    expect(cleanLimit(' 0.005 ', TRY_JOB_LIMIT)).toBe(5_000n)
    expect(cleanLimit('0.01', TRY_JOB_LIMIT)).toBe(TRY_JOB_LIMIT)
    expect(cleanLimit('5', TRY_JOB_LIMIT)).toBe(TRY_JOB_LIMIT)
    for (const bad of ['0', '0.0000001', '-1', 'abc', '1e3', '', 0.001, {}, []]) expect(cleanLimit(bad, TRY_JOB_LIMIT)).toBeNull()
  })

  test('the page offers 0.001, 0.005 and 0.01, and starts at the server limit', () => {
    expect([...LIMIT_CHOICES]).toEqual(['0.001', '0.005', '0.01'])
    expect(DEFAULT_LIMIT).toBe(formatUsdc(TRY_JOB_LIMIT))
  })

  test('a limit that is not an amount is refused before anything is read', async () => {
    const { handle, bought, paid } = setup()
    expect((await handle(post({ step: 'plan', job: PAYMENT_JOB, limit: 'lots' }))).status).toBe(400)
    expect((await handle(post({ step: 'approve', job: PAYMENT_JOB, id: `${Date.now()}.${'a'.repeat(64)}`, limit: '-1' }))).status).toBe(400)
    expect(bought).toEqual([])
    expect(paid).toEqual([])
  })
})

describe('the four examples pick as before at the default limit', () => {
  for (const limit of [undefined, '0.01']) {
    test(`with the limit ${limit ?? 'left out'}`, async () => {
      const { handle } = setup()
      const payment = await planOf(handle, PAYMENT_JOB, limit)
      expect(payment.sellerName).toBe(PAYMENT_CHECK_NAME)
      expect(payment.compared.map((c) => `${c.sellerName} ${c.note}`)).toEqual([
        `${PAYMENT_CHECK_NAME} Picked`,
        'Quicknode Lower match',
        'BotPay Only a payment word matched',
      ])
      expect(payment.limitLine).toBe('Each job can spend at most 0.01 USDC.')
      expect(payment.protection).toBe(PROTECTED_LINE)

      const receipt = await planOf(handle, RECEIPT_JOB, limit)
      expect(receipt.sellerName).toBe('BotPay')
      expect(receipt.amount).toBe('0.01')
      expect(receipt.compared.map((c) => `${c.sellerName} ${c.listing} ${c.note}`)).toEqual([
        'BotPay pay Picked',
        'BotPay go Over the limit',
        'Quicknode arc-testnet Lower match',
      ])

      const weather = await planBody(handle, WEATHER_JOB, limit)
      expect(weather).toEqual({
        ok: false,
        code: 'NO_SELLER',
        message: 'I couldn’t find anyone who can do this job. None of the 134 Arc listings matched. Nothing was paid.',
        compared: [],
      })

      expect((await planOf(handle, BALANCE_JOB, limit)).sellerName).toBe(BALANCE_CHECK_NAME)
    })
  }
})

describe('a lower limit', () => {
  test('0.001: Payment Check still fits, and the card says the limit the person chose', async () => {
    const { handle, bought } = setup()
    const plan = await planOf(handle, PAYMENT_JOB, '0.001')
    expect(plan.sellerName).toBe(PAYMENT_CHECK_NAME)
    expect(plan.amount).toBe('0.001')
    expect(plan.limitLine).toBe('Each job can spend at most 0.001 USDC.')
    const res = await handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id, limit: '0.001' }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as PaidReply).paid).toBe('0.001')
    expect(bought).toEqual([{ name: PAYMENT_CHECK_NAME, cap: 1_000n, lineDropped: false }])
  })

  test('0.001: the receipt job is over it, so nothing is paid and the agent does not fall back to a weaker match', async () => {
    const { handle, paid, bought } = setup()
    const body = await planBody(handle, RECEIPT_JOB, '0.001')
    if (body.ok) throw new Error(`expected a refusal, got ${body.plan.sellerName}`)
    expect(body.code).toBe('OVER_LIMIT')
    expect(body.message).toBe('Over your limit of 0.001 USDC. Nothing was paid.')
    expect(body.compared.map((c) => `${c.sellerName} ${c.note}`)).toEqual([
      `BotPay ${OVER_YOUR_LIMIT_NOTE}`,
      'BotPay Over the limit',
      'Quicknode Lower match',
    ])
    expect(paid).toEqual([])
    expect(bought).toEqual([])
  })

  test('0.005: the same, with the limit it names', async () => {
    const { handle } = setup()
    const body = await planBody(handle, RECEIPT_JOB, '0.005')
    expect(body.ok ? null : body.message).toBe('Over your limit of 0.005 USDC. Nothing was paid.')
  })

  test('0.001: the balance job still picks Balance Check, and the weather job still finds nobody', async () => {
    const { handle } = setup()
    expect((await planOf(handle, BALANCE_JOB, '0.001')).sellerName).toBe(BALANCE_CHECK_NAME)
    expect((await planBody(handle, WEATHER_JOB, '0.001')).ok).toBe(false)
  })

  test('a limit above the server limit is the server limit', async () => {
    const { handle } = setup()
    expect((await planOf(handle, PAYMENT_JOB, '5')).limitLine).toBe(limitLine(TRY_JOB_LIMIT))
  })
})

describe('an approval cannot raise the limit the card was planned with', () => {
  test('a plan under 0.001 approved with 0.01, or with no limit, pays nothing', async () => {
    const { handle, bought, clock } = setup()
    const plan = await planOf(handle, PAYMENT_JOB, '0.001')
    for (const limit of ['0.01', '0.005', undefined]) {
      const res = await handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id, ...(limit ? { limit } : {}) }))
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('EXPIRED')
    }
    expect(bought).toEqual([])
    // The same card, with the limit it was planned with, still pays once.
    clock.t += 1
    expect((await handle(post({ step: 'approve', job: PAYMENT_JOB, id: plan.id, limit: '0.001' }))).status).toBe(200)
    expect(bought).toHaveLength(1)
  })

  test('a plan under 0.01 approved with a lower limit pays nothing either', async () => {
    const { handle, paid } = setup()
    const plan = await planOf(handle, RECEIPT_JOB, '0.01')
    const res = await handle(post({ step: 'approve', job: RECEIPT_JOB, id: plan.id, limit: '0.001' }))
    expect(res.status).toBe(409)
    expect(paid).toEqual([])
  })
})

describe('the dropped line, tried on purpose', () => {
  test('buys the protected vet402 seller once, with the key kept off the connection', async () => {
    const { handle, bought } = setup()
    const plan = await planOf(handle, BALANCE_JOB, '0.001')
    expect(plan.protection).toBe(PROTECTED_LINE)
    const res = await handle(post({ step: 'approve', job: BALANCE_JOB, id: plan.id, limit: '0.001', lineDropped: true }))
    expect(res.status).toBe(200)
    expect(bought).toEqual([{ name: BALANCE_CHECK_NAME, cap: 1_000n, lineDropped: true }])
  })

  test('keeps to the same two minutes per address as every paid job', async () => {
    const { handle, bought, clock } = setup()
    const first = await planOf(handle, PAYMENT_JOB)
    expect((await handle(post({ step: 'approve', job: PAYMENT_JOB, id: first.id, lineDropped: true }))).status).toBe(200)
    const again = await planOf(handle, PAYMENT_JOB)
    expect((await handle(post({ step: 'approve', job: PAYMENT_JOB, id: again.id, lineDropped: true }))).status).toBe(429)
    clock.t += JOB_IP_GAP_MS
    const later = await planOf(handle, PAYMENT_JOB)
    expect((await handle(post({ step: 'approve', job: PAYMENT_JOB, id: later.id, lineDropped: true }))).status).toBe(200)
    expect(bought.map((b) => b.lineDropped)).toEqual([true, true])
  })

  test('is refused for a catalog seller, and for a card without the protection line', async () => {
    const catalogPick = setup()
    const receipt = await planOf(catalogPick.handle, RECEIPT_JOB)
    expect(receipt.protection).toBeUndefined()
    expect((await catalogPick.handle(post({ step: 'approve', job: RECEIPT_JOB, id: receipt.id, lineDropped: true }))).status).toBe(400)
    expect(catalogPick.paid).toEqual([])

    // Without the deposit read, the agent does not pick the sealed seller at all, so there is nothing to try.
    const unprotected = setup({ covers: false })
    const payment = await planOf(unprotected.handle, PAYMENT_JOB)
    expect(payment.protection).toBeUndefined()
    expect((await unprotected.handle(post({ step: 'approve', job: PAYMENT_JOB, id: payment.id, lineDropped: true }))).status).toBe(400)
    expect(unprotected.bought).toEqual([])
    expect(unprotected.paid).toEqual([])
  })
})

// The dropped line against an in-memory chain: the hold claims, the seller's lookout answers on Arc with a memo, and the
// agent reads the key there and opens the box. Every step is recorded in the order it happens.

const holdKey = generatePrivateKey()
const sellerKey = generatePrivateKey()
const buyerKey = generatePrivateKey()
const HOLD = privateKeyToAccount(holdKey).address
const REAL_SELLER = privateKeyToAccount(sellerKey).address
const CLAIM_TX: Hex = `0x${'1a'.repeat(32)}`
const ANSWER_TX: Hex = `0x${'2b'.repeat(32)}`

const facilitator: SellerFacilitator = {
  verify: () => Promise.resolve({ isValid: true }),
  settle: () => Promise.resolve({ success: true, transaction: TRANSFER_ID }),
}

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function fakeChain() {
  const steps: string[] = []
  const claims: { claimId: Hex; paymentNonce: Hex; seller: Address; deadline: bigint; block: bigint }[] = []
  const keys = new Map<Hex, Hex>()
  const memos: (ClaimLinks | undefined)[] = []
  const gas: Address[] = []
  // Nothing on this net is ever reached: every chain call below is answered in memory.
  const real = createSealedDelivery({ address: SEALED, net: { chain: arcTestnet, rpcUrl: 'http://127.0.0.1:9', pollingMs: 5 } })
  const ports = createSealedPorts({ client: real, holdKey, buyerKey, rejected: new Set() })
  const client = {
    ...real,
    latestBlock: () => Promise.resolve(claims.length ? 2n : 1n),
    readClaimed: (seller: Address, from: bigint, to: bigint) =>
      Promise.resolve(claims.filter((c) => c.seller.toLowerCase() === seller.toLowerCase() && c.block >= from && c.block <= to)),
    chainTime: () => Promise.resolve(1n),
    tryAnswer: () => Promise.resolve(null),
    ensureGas: (_from: Hex, to: Address) => {
      gas.push(to)
      return Promise.resolve(0n)
    },
    answer: (_key: Hex, claimId: Hex, key: Hex, links?: ClaimLinks) => {
      steps.push('answer')
      memos.push(links)
      keys.set(claimId, key)
      return Promise.resolve(links ?? null)
    },
  }
  const sealed = {
    requestKey: ports.requestKey,
    coverageFor: () => Promise.resolve(true),
    chainTime: () => Promise.resolve(1n),
    readBox: (body: string) => {
      const box = (JSON.parse(body) as { sealed?: SealedBox }).sealed
      return Promise.resolve(box ? { kind: 'box' as const, box } : { kind: 'plain' as const })
    },
    claim: (box: SealedBox) => {
      steps.push('claim')
      const claimId = claimIdOf(REAL_SELLER, HOLD, box.promise.paymentNonce as Hex)
      claims.push({ claimId, paymentNonce: box.promise.paymentNonce as Hex, seller: REAL_SELLER, deadline: 10_000n, block: 2n })
      return Promise.resolve({ claimId, deadline: 10_000n, fromBlock: 2n, transactionHash: CLAIM_TX })
    },
    readKey: (claimId: Hex) => {
      const key = keys.get(claimId)
      if (!key) return Promise.resolve(null)
      if (!steps.includes('key read')) steps.push('key read')
      return Promise.resolve({ key, block: 2n, transactionHash: ANSWER_TX })
    },
    claimGasRepaid: () => Promise.resolve({ amount: 12_268n, sent: true }),
  }
  return { client, sealed, steps, memos, gas, keys }
}

function droppedSeller(handsOverKey = true) {
  const chain = fakeChain()
  const check = createPaymentCheck({
    client: chain.client,
    sealed: chain.sealed,
    sealedAddress: SEALED,
    keys: { hold: holdKey, seller: sellerKey, buyer: buyerKey },
    facilitator,
    holdAvailable: () => Promise.resolve(1_000_000n),
    handsOverKey: () => handsOverKey,
    lastPayment: () => Promise.resolve("Yes, your agent's last payment went through."),
    watchMs: 10,
    pollMs: 10,
    keyWaitMs: 3_000,
    log: () => {},
  })
  return { ...chain, check }
}

describe('the dropped line against a fake chain', () => {
  test('the hold claims, the seller answers on Arc with a memo, and the agent opens the answer, in that order', async () => {
    const { check, steps, memos, gas, keys } = droppedSeller()
    const result = await check.buy(DEMO_PRICE, { lineDropped: true })

    expect(steps).toEqual(['claim', 'answer', 'key read'])
    expect(result.data).toBe("Yes, your agent's last payment went through.")
    expect(result.paid).toBe(DEMO_PRICE)
    // The seller got its answer's gas from the buyer before the claim, as in the dispute try.
    expect(gas.map((a) => a.toLowerCase())).toEqual([REAL_SELLER.toLowerCase()])
    // The answer's memo points at the Gateway transfer of this payment.
    expect(memos[0]?.gatewayTransferId).toBe(TRANSFER_ID)

    expect(result.lines?.[0]).toBe(LINE_DROPPED_ANSWERED)
    expect(result.lines?.slice(1).every((line) => line.startsWith('Detail: '))).toBe(true)
    expect(result.lines).toContain(`Detail: ${DELIVERED_FROM_ARC}`)
    expect(result.lines).toContain(`Detail: Claim transaction: ${CLAIM_TX}.`)
    expect(result.lines).toContain(`Detail: Answer transaction: ${ANSWER_TX}.`)
    expect(result.lines).toContain('Detail: Claim gas repaid by the seller: 0.012268 USDC.')
    // The key itself is never on the receipt.
    const [key] = [...keys.values()]
    expect(result.lines?.join('\n')).not.toContain(key!.slice(2))
  })

  test('without the dropped line the key comes over the connection and nothing touches the chain', async () => {
    const { check, steps } = droppedSeller()
    const result = await check.buy(DEMO_PRICE)
    expect(steps).toEqual([])
    expect(result.lines?.[0]).toBe('Answer received and checked. You paid 0.001 USDC once.')
  })

  test('a line that really drops keeps its own receipt, as before', async () => {
    const { check, steps } = droppedSeller(false)
    const result = await check.buy(DEMO_PRICE)
    expect(steps).toEqual(['claim', 'answer', 'key read'])
    expect(result.lines?.[0]).toBe('Answer received and checked. You paid 0.001 USDC once.')
    expect(result.lines).not.toContain(LINE_DROPPED_ANSWERED)
  })
})

/** A Storage in memory. `broken` throws on every call, as a blocked one does. */
function memoryStorage(broken = false): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => {
      if (broken) throw new Error('blocked')
      return data.get(key) ?? null
    },
    setItem: (key, value) => {
      if (broken) throw new Error('blocked')
      data.set(key, value)
    },
  }
}

const bought = (at: number, amount = '0.001'): Purchase => ({ sellerName: PAYMENT_CHECK_NAME, amount, line: `answer ${at}`, at })

describe('what the browser keeps', () => {
  test('the chosen limit is remembered, and anything else gives the default', () => {
    const store = memoryStorage()
    expect(loadLimit(store)).toBe('0.01')
    saveLimit('0.001', store)
    expect(loadLimit(store)).toBe('0.001')
    store.data.set('vet402.agent.limit', '7')
    expect(loadLimit(store)).toBe('0.01')
    expect(loadLimit(null)).toBe('0.01')
    expect(loadLimit(memoryStorage(true))).toBe('0.01')
    expect(() => saveLimit('0.005', memoryStorage(true))).not.toThrow()
  })

  test('purchases are kept newest first, at most ten, and nothing charged is not one', () => {
    const store = memoryStorage()
    for (let i = 1; i <= 12; i++) addPurchase(bought(i * 1000), store)
    const list = loadPurchases(store)
    expect(list).toHaveLength(MAX_PURCHASES)
    expect(list[0]?.at).toBe(12_000)
    expect(list.at(-1)?.at).toBe(3_000)
    expect(addPurchase(bought(13_000, '0'), store)).toHaveLength(MAX_PURCHASES)
    expect(loadPurchases(store)[0]?.at).toBe(12_000)
  })

  test('the answer is kept as one short line', () => {
    const store = memoryStorage()
    const [first] = addPurchase({ ...bought(1), line: `Yes,\n  it went\tthrough. ${'x'.repeat(300)}` }, store)
    expect(first?.line.startsWith('Yes, it went through. x')).toBe(true)
    expect(first?.line.length).toBeLessThanOrEqual(120)
  })

  test('a broken or blocked store gives an empty list and never throws', () => {
    const store = memoryStorage()
    store.data.set('vet402.agent.purchases', '{not json')
    expect(loadPurchases(store)).toEqual([])
    store.data.set('vet402.agent.purchases', JSON.stringify([{ sellerName: 1 }, bought(5)]))
    expect(loadPurchases(store).map((p) => p.at)).toEqual([5])
    expect(loadPurchases(memoryStorage(true))).toEqual([])
    expect(() => addPurchase(bought(9), memoryStorage(true))).not.toThrow()
    expect(loadPurchases(null)).toEqual([])
  })
})

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')

describe('the screen', () => {
  test("the limit row sits above Ask the agent, at the server's limit, and the list says nothing was bought yet", () => {
    const html = renderToStaticMarkup(<PublicApp />)
    const text = textOf(html)
    expect(text).toContain('Your agent’s limit')
    expect(text).toContain('Spend up to 0.001 0.005 0.01 USDC per job')
    expect(html).toContain('<option value="0.01" selected="">0.01</option>')
    expect(text.indexOf('Your agent’s limit')).toBeLessThan(text.indexOf('Ask the agent'))
    expect(text).toContain('What your agent bought')
    expect(text).toContain('Nothing yet.')
  })

  test('the limit row can be locked while a card is open', () => {
    expect(renderToStaticMarkup(<LimitRow value="0.005" onChange={() => {}} disabled />)).toContain('disabled=""')
  })

  test('the list shows the seller, the amount and the answer in one line, newest first', () => {
    const html = renderToStaticMarkup(<PurchaseList purchases={[bought(2_000_000_000_000), bought(1_900_000_000_000, '0.0001')]} />)
    const text = textOf(html)
    expect(text).toContain(`${PAYMENT_CHECK_NAME} 0.001 USDC answer 2000000000000`)
    expect(text.indexOf('answer 2000000000000')).toBeLessThan(text.indexOf('answer 1900000000000'))
    expect(text).not.toContain('Nothing yet.')
  })

  test('the card says the limit the person chose', () => {
    const html = renderToStaticMarkup(<SpendQuestion plan={{ amount: '0.001', limitLine: limitLine(1_000n), protection: PROTECTED_LINE }} />)
    expect(html).toContain('Each job can spend at most 0.001 USDC.')
  })

  test('the dropped line link is there only with the protection line', () => {
    expect(renderToStaticMarkup(<DroppedLineLink plan={{ protection: PROTECTED_LINE }} onTry={() => {}} />)).toContain('Try it with the line dropped')
    expect(renderToStaticMarkup(<DroppedLineLink plan={{}} onTry={() => {}} />)).toBe('')
  })

  test('the receipt reads plainly: paid, then confirming, and the claim only under Details', () => {
    expect(receiptLine('0.001', false)).toBe('Paid 0.001 USDC. Confirming…')
    expect(receiptLine('0.001', true)).toBe('Paid 0.001 USDC.')
    expect(receiptLine('0', false)).toBe('Nothing was charged.')

    const html = renderToStaticMarkup(
      <SealedLines lines={[LINE_DROPPED_ANSWERED, `Detail: ${DELIVERED_FROM_ARC}`, `Detail: Claim transaction: ${CLAIM_TX}.`]} />,
    )
    const [body, details] = html.split('<details')
    expect(textOf(body ?? '')).toContain('The line dropped. vet402 asked Arc, the seller answered there, and you got your answer. Charged once.')
    expect(body).not.toMatch(/claim|gas|0x/i)
    expect(details).toContain(CLAIM_TX)
  })
})
