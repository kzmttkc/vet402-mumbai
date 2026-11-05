import { describe, expect, test } from 'bun:test'
import { fetchCandidates, toCandidate } from '../discovery'
import type { Candidate, FetchLike } from '../discovery'
import { createJobService, describeReceipt, JobError } from '../jobs'
import type { JobPorts } from '../jobs'
import { isSafeResource, planJob } from '../planner'
import type { PlannedRequest } from '../planner'

// These tests do no file work at all, so there is nothing for them to read or write
// outside memory. `bun run test` also runs them from an empty temporary folder.

const NETWORK = 'eip155:5042002'
const TX = `0x${'ab'.repeat(32)}`

interface ListingOptions {
  resource?: string
  method?: string
  siwx?: boolean
  path?: string
  name?: string
  category?: string
  description?: string
  tags?: string[]
  amount?: string
  accepts?: object[]
  body?: object
}

const batched = (amount: string, network = NETWORK) => ({
  scheme: 'exact',
  network,
  amount,
  extra: { name: 'GatewayWalletBatched', version: '1' },
})

function listing(o: ListingOptions = {}) {
  return {
    resource: o.resource ?? 'https://seller.example.com/data',
    type: 'http',
    accepts: o.accepts ?? [batched(o.amount ?? '1000')],
    metadata: {
      provider: {
        name: o.name ?? 'Example Seller',
        description: 'Provider text',
        category: o.category ?? 'FINANCIAL_ANALYSIS',
        tags: o.tags ?? ['prices'],
      },
      path: o.path ?? '/data',
      method: o.method ?? 'GET',
      description: o.description ?? 'Listing text',
      input: o.body ? { body: o.body } : undefined,
      siwx: o.siwx ?? false,
    },
  }
}

const relayListing = (o: ListingOptions = {}) =>
  listing({
    resource: 'https://relay.example.com/arc-testnet/',
    method: 'POST',
    siwx: true,
    path: '/arc-testnet',
    name: 'Relay Co',
    category: 'INFRASTRUCTURE',
    description: 'JSON-RPC proxy for Arc Testnet on eip155:5042002',
    amount: '100',
    body: { required: ['jsonrpc', 'method'], properties: { jsonrpc: {}, method: {}, params: {}, id: {} } },
    ...o,
  })

function candidate(raw: ReturnType<typeof listing>): Candidate {
  const c = toCandidate(raw, NETWORK)
  if (!c) throw new Error('fixture should be a candidate')
  return c
}

describe('Discovery', () => {
  test('never sends the siwx filter and pages through every result', async () => {
    const urls: string[] = []
    const first = Array.from({ length: 200 }, (_, i) => listing({ resource: `https://s${i}.example.com/x` }))
    const second = [listing({ resource: 'https://last.example.com/x' })]
    const fetchImpl: FetchLike = (url) => {
      urls.push(url)
      const offset = Number(new URL(url).searchParams.get('offset'))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: offset === 0 ? first : second, pagination: { total: 201 } }),
      })
    }

    const found = await fetchCandidates(NETWORK, fetchImpl)

    expect(found).toHaveLength(201)
    expect(urls).toHaveLength(2)
    for (const url of urls) {
      const params = new URL(url).searchParams
      expect(params.has('siwx')).toBe(false)
      expect(params.get('network')).toBe(NETWORK)
    }
  })

  test('keeps POST listings and listings with siwx true', () => {
    expect(toCandidate(relayListing(), NETWORK)).not.toBeNull()
    expect(toCandidate(listing({ method: 'POST', siwx: true }), NETWORK)).not.toBeNull()
  })

  test('needs the batched option on this network', () => {
    const otherNetwork = listing({ accepts: [batched('100', 'eip155:8453')] })
    const plainUsdc = listing({
      accepts: [{ scheme: 'exact', network: NETWORK, amount: '100', extra: { name: 'USDC' } }],
    })
    expect(toCandidate(otherNetwork, NETWORK)).toBeNull()
    expect(toCandidate(plainUsdc, NETWORK)).toBeNull()
  })

  test('uses the price of the batched option, not of other options', () => {
    const mixed = listing({
      accepts: [
        { scheme: 'exact', network: NETWORK, amount: '999999', extra: { name: 'USDC' } },
        batched('250'),
      ],
    })
    expect(toCandidate(mixed, NETWORK)?.amount).toBe(250n)
  })
})

describe('Planning a payment check', () => {
  const candidates = [
    candidate(listing({ name: 'Market Co', tags: ['payment', 'receipt'] })),
    candidate(relayListing()),
  ]

  test('prefers the relay and plans exactly one receipt lookup for the latest batch transaction', () => {
    const outcome = planJob('Did my payment go through?', candidates, { batchTx: TX })
    if (!outcome.ok) throw new Error('expected a plan')

    expect(outcome.plan.kind).toBe('receipt-check')
    expect(outcome.plan.sellerName).toBe('Relay Co')
    expect(outcome.plan.request).toEqual({
      url: 'https://relay.example.com/arc-testnet/',
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [TX] },
    })
  })

  test('asks for the relay price', () => {
    const outcome = planJob('did the payment go through', candidates, { batchTx: TX })
    expect(outcome.ok && outcome.plan.amount).toBe(100n)
  })

  test('says so when there is no payment yet', () => {
    expect(planJob('did my payment go through', candidates, null)).toEqual({ ok: false, reason: 'NO_PAYMENTS' })
  })

  test('says so when the latest payment is not batched yet', () => {
    expect(planJob('did my payment go through', candidates, { batchTx: null })).toEqual({
      ok: false,
      reason: 'NOT_SETTLED',
    })
  })

  test('never puts a malformed transaction hash in a request', () => {
    expect(planJob('did my payment go through', candidates, { batchTx: '0x1234' })).toEqual({
      ok: false,
      reason: 'NOT_SETTLED',
    })
  })
})

describe('Planning a general job', () => {
  const market = candidate(listing({ name: 'Market Co', tags: ['crypto', 'prices'], amount: '5000' }))
  const cheaperMarket = candidate(
    listing({ resource: 'https://cheap.example.com/p', name: 'Cheap Market', tags: ['crypto', 'prices'], amount: '1000' }),
  )
  const weather = candidate(
    listing({ resource: 'https://wx.example.com/w', name: 'Weather Co', category: 'WEB_SEARCH_RESEARCH', tags: ['weather'] }),
  )

  test('picks the seller whose listing fits and, on a tie, the cheaper one', () => {
    const outcome = planJob('crypto prices please', [market, weather, cheaperMarket], null)
    expect(outcome.ok && outcome.plan.sellerName).toBe('Cheap Market')
  })

  test('says so when nobody fits', () => {
    expect(planJob('book me a flight', [market, weather], null)).toEqual({ ok: false, reason: 'NO_SELLER' })
  })

  test('skips listings that need fields it cannot fill', () => {
    const needsKey = candidate(
      listing({
        method: 'POST',
        name: 'Picky',
        tags: ['weather'],
        body: { required: ['apiKey'], properties: { apiKey: {} } },
      }),
    )
    expect(planJob('weather today', [needsKey], null)).toEqual({ ok: false, reason: 'NO_SELLER' })
  })

  test('puts the job into a text field when the listing has one', () => {
    const search = candidate(
      listing({
        method: 'POST',
        name: 'Search Co',
        tags: ['weather'],
        body: { required: ['query'], properties: { query: {} } },
      }),
    )
    const outcome = planJob('weather today', [search], null)
    expect(outcome.ok && outcome.plan.request.body).toEqual({ query: 'weather today' })
  })

  test('does not use the payment relay for other jobs', () => {
    expect(planJob('weather today', [candidate(relayListing())], null)).toEqual({ ok: false, reason: 'NO_SELLER' })
  })

  test('shows our own sentence and the seller name, never the listing text', () => {
    const outcome = planJob('crypto prices please', [market], null)
    if (!outcome.ok) throw new Error('expected a plan')
    const shown = `${outcome.plan.sellerName} ${outcome.plan.summary}`

    expect(shown).not.toContain('Listing text')
    expect(shown).not.toContain('Provider text')
    expect(outcome.plan.summary).toBe('Looks up market data to help with this job.')
  })

  test('the payment check sentence never names a network', () => {
    const outcome = planJob('did my payment go through', [candidate(relayListing())], { batchTx: TX })
    if (!outcome.ok) throw new Error('expected a plan')
    expect(`${outcome.plan.sellerName} ${outcome.plan.summary}`).not.toMatch(/arc|testnet|eip155|base|polygon/i)
  })

  test('ignores an empty job', () => {
    expect(planJob('   ', [market], null)).toEqual({ ok: false, reason: 'EMPTY_JOB' })
  })
})

describe('Resource safety', () => {
  test('only calls plain https hostnames', () => {
    expect(isSafeResource('https://seller.example.com/x')).toBe(true)
    expect(isSafeResource('http://seller.example.com/x')).toBe(false)
    expect(isSafeResource('https://localhost/x')).toBe(false)
    expect(isSafeResource('https://127.0.0.1/x')).toBe(false)
    expect(isSafeResource('https://[::1]/x')).toBe(false)
    expect(isSafeResource('https://user:pw@seller.example.com/x')).toBe(false)
    expect(isSafeResource('not a url')).toBe(false)
  })

  test('a listing pointing at an unsafe address is never chosen', () => {
    const bad = candidate(listing({ resource: 'https://169.254.169.254/latest', tags: ['weather'] }))
    expect(planJob('weather today', [bad], null)).toEqual({ ok: false, reason: 'NO_SELLER' })
  })
})

describe('The job flow', () => {
  function setup(overrides: Partial<JobPorts> & { available?: bigint } = {}) {
    const paid: { request: PlannedRequest; cap: bigint }[] = []
    let receiptReads = 0
    const ports: JobPorts = {
      candidates: () => Promise.resolve([candidate(relayListing()), candidate(listing({ tags: ['weather'] }))]),
      latestReceipt: () => {
        receiptReads++
        return Promise.resolve({ batchTx: TX })
      },
      holdAvailable: () => Promise.resolve(overrides.available ?? 1_000_000n),
      pay: (request, cap) => {
        paid.push({ request, cap })
        return Promise.resolve({ data: { result: { status: '0x1' } }, paid: 100n })
      },
      ...overrides,
    }
    return { ports, paid, receiptReads: () => receiptReads }
  }

  test('the approval card carries only the seller, one sentence, and the amount', async () => {
    const jobs = createJobService(setup().ports)
    const view = await jobs.plan('did my payment go through')

    expect(Object.keys(view).sort()).toEqual(['amount', 'covered', 'id', 'sellerName', 'summary'])
    expect(view.sellerName).toBe('Relay Co')
    expect(view.amount).toBe('0.0001')
    expect(view.covered).toBe(true)
  })

  test('approving pays once, capped at the approved amount, from the plan the agent chose', async () => {
    const { ports, paid } = setup()
    const jobs = createJobService(ports)
    const view = await jobs.plan('did my payment go through')

    const result = await jobs.approve(view.id)

    expect(result).toEqual({ text: 'Yes, your payment went through.', paid: '0.0001' })
    expect(paid).toHaveLength(1)
    expect(paid[0]?.cap).toBe(100n)
    expect(paid[0]?.request.body).toMatchObject({ method: 'eth_getTransactionReceipt', params: [TX] })
  })

  test('an approval works only once', async () => {
    const { ports, paid } = setup()
    const jobs = createJobService(ports)
    const view = await jobs.plan('did my payment go through')

    await jobs.approve(view.id)
    await expect(jobs.approve(view.id)).rejects.toMatchObject({ code: 'UNKNOWN_PLAN' })
    expect(paid).toHaveLength(1)
  })

  test('nothing is paid when the hold does not cover the amount', async () => {
    const { ports, paid } = setup({ available: 50n })
    const jobs = createJobService(ports)
    const view = await jobs.plan('did my payment go through')
    expect(view.covered).toBe(false)

    await expect(jobs.approve(view.id)).rejects.toMatchObject({ code: 'NOT_COVERED' })
    expect(paid).toHaveLength(0)
  })

  test('an unknown approval pays nothing', async () => {
    const { ports, paid } = setup()
    await expect(createJobService(ports).approve('nope')).rejects.toBeInstanceOf(JobError)
    expect(paid).toHaveLength(0)
  })

  test('an approval expires', async () => {
    let clock = 0
    const { ports, paid } = setup()
    const jobs = createJobService(ports, () => clock)
    const view = await jobs.plan('did my payment go through')

    clock += 11 * 60 * 1000

    await expect(jobs.approve(view.id)).rejects.toMatchObject({ code: 'UNKNOWN_PLAN' })
    expect(paid).toHaveLength(0)
  })

  test('only reads payment history for payment jobs', async () => {
    const setupResult = setup()
    const jobs = createJobService(setupResult.ports)

    await jobs.plan('weather today')
    expect(setupResult.receiptReads()).toBe(0)

    await jobs.plan('did my payment go through')
    expect(setupResult.receiptReads()).toBe(1)
  })

  test('a failed payment is reported without details', async () => {
    const { ports } = setup({ pay: () => Promise.reject(new Error('seller exploded eip155:5042002')) })
    const jobs = createJobService(ports)
    const view = await jobs.plan('did my payment go through')

    const error = await jobs.approve(view.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JobError)
    expect((error as JobError).message).toBe('The job couldn’t be completed.')
  })

  test('describes receipts in plain words', () => {
    expect(describeReceipt({ result: { status: '0x1' } })).toBe('Yes, your payment went through.')
    expect(describeReceipt({ result: { status: '0x0' } })).toBe('No, that payment didn’t go through.')
    expect(describeReceipt({ result: null })).toBe('It hasn’t been confirmed yet.')
  })
})
