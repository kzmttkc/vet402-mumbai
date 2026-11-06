import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { toCandidate } from '../discovery'
import type { Candidate } from '../discovery'
import { createJobService } from '../jobs'
import type { JobPorts } from '../jobs'
import { decide, planJob, rankJob } from '../planner'
import type { PlannedRequest } from '../planner'
import { memoryStore } from './helpers'

// The agent's pick, tested on Circle's real Arc testnet catalog as read on 2026-11-06 (134 listings:
// 132 Quicknode JSON-RPC nodes and 2 BotPay listings). Nothing here reaches the network.

const NETWORK = 'eip155:5042002'
const TX = `0x${'ab'.repeat(32)}`
const CTX = { networkName: 'Arc Testnet', limit: 10_000n }

const raw = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures/arc-discovery-2026-11-06.json'), 'utf8'),
) as { items: Parameters<typeof toCandidate>[0][] }
const catalog: Candidate[] = raw.items.flatMap((item) => {
  const c = toCandidate(item, NETWORK)
  return c ? [c] : []
})

function servicePorts(candidates: Candidate[]) {
  const paid: { request: PlannedRequest; cap: bigint }[] = []
  const ports: JobPorts = {
    candidates: () => Promise.resolve(candidates),
    latestReceipt: () => Promise.resolve({ batchTx: TX }),
    holdAvailable: () => Promise.resolve(1_000_000n),
    pay: (request, cap) => {
      paid.push({ request, cap })
      return Promise.resolve({ data: { result: { status: '0x1' } }, paid: cap, nonce: null, timesReceived: 1, transaction: '' })
    },
    findTransfer: () => Promise.resolve(null),
    fetchTransfer: () => Promise.reject(new Error('not used')),
  }
  return { ports, paid }
}

describe('The agent picks from the real Arc catalog', () => {
  test('the catalog has 134 payable listings', () => {
    expect(catalog).toHaveLength(134)
  })

  test('"Did my last payment go through?" picks the Quicknode node on Arc Testnet, as before', () => {
    const outcome = planJob('Did my last payment go through?', catalog, CTX, { batchTx: TX })
    if (!outcome.ok) throw new Error(`expected a plan, got ${outcome.reason}`)

    expect(outcome.plan.sellerName).toBe('Quicknode')
    expect(outcome.plan.kind).toBe('receipt-check')
    expect(outcome.plan.amount).toBe(100n)
    expect(outcome.plan.request).toEqual({
      url: 'https://x402.quicknode.com/arc-testnet/',
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [TX] },
    })
    expect(outcome.plan.why).toBe("Picked from 134 Arc listings: best match for 'payment', 0.0001 USDC")
    expect(outcome.plan.compared).toEqual([
      { sellerName: 'Quicknode', listing: 'arc-testnet', amount: '0.0001', note: 'Picked' },
      { sellerName: 'BotPay', listing: 'go', amount: '0.1', note: 'Only a payment word matched' },
      { sellerName: 'BotPay', listing: 'pay', amount: '0.01', note: 'Only a payment word matched' },
    ])
  })

  test('"Get me a paid access receipt" picks a different seller, BotPay', () => {
    const outcome = planJob('Get me a paid access receipt', catalog, CTX, null)
    if (!outcome.ok) throw new Error(`expected a plan, got ${outcome.reason}`)

    expect(outcome.plan.sellerName).toBe('BotPay')
    expect(outcome.plan.kind).toBe('lookup')
    expect(outcome.plan.request).toEqual({ url: 'https://api.botpay.network/pay', method: 'GET' })
    expect(outcome.plan.amount).toBe(10_000n)
    expect(outcome.plan.why).toBe("Picked from 134 Arc listings: best match for 'paid access receipt', 0.01 USDC")
    expect(outcome.plan.compared?.map((c) => `${c.sellerName} ${c.listing} ${c.note}`)).toEqual([
      'BotPay pay Picked',
      'BotPay go Over the limit',
      'Quicknode arc-testnet Lower match',
    ])
  })

  test('"What\'s the weather in Mumbai?" finds nobody and says so, without paying', async () => {
    const outcome = planJob("What's the weather in Mumbai?", catalog, CTX, { batchTx: TX })
    expect(outcome).toEqual({
      ok: false,
      reason: 'NO_SELLER',
      why: 'I couldn’t find anyone who can do this job. None of the 134 Arc listings matched. Nothing was paid.',
      compared: [],
    })

    const { ports, paid } = servicePorts(catalog)
    const jobs = createJobService(ports, memoryStore())
    await expect(jobs.plan("What's the weather in Mumbai?")).rejects.toThrow('None of the 134 Arc listings matched')
    expect(paid).toHaveLength(0)
  })

  test('a price question finds nobody either: the catalog sells no prices', () => {
    expect(planJob('What is the price of ETH?', catalog, CTX, null)).toMatchObject({ ok: false, reason: 'NO_SELLER' })
  })

  test('a seller over the limit is not paid, and the answer names the price', () => {
    expect(planJob('Get me a verification code', catalog, CTX, null)).toEqual({
      ok: false,
      reason: 'OVER_LIMIT',
      why: 'BotPay fits best but asks 0.1 USDC, over the 0.01 USDC limit. Nothing was paid.',
      compared: [{ sellerName: 'BotPay', listing: 'go', amount: '0.1', note: 'Over the limit' }],
    })
    const higher = planJob('Get me a verification code', catalog, { ...CTX, limit: 100_000n }, null)
    expect(higher.ok && higher.plan.request.url).toBe('https://api.botpay.network/go')
  })

  test('a node it cannot fill a request for is never paid', () => {
    expect(planJob('latest block on base sepolia', catalog, CTX, null)).toMatchObject({
      ok: false,
      reason: 'NO_SELLER',
      why: 'I couldn’t find anyone who can do this job. The best of the 134 Arc listings, Quicknode, needs details I can’t fill in. Nothing was paid.',
    })
  })
})

describe('Nothing in the pick is fixed', () => {
  test('the node comes from where the agent pays: on Base Sepolia it would pick that node', () => {
    const outcome = planJob('Did my last payment go through?', catalog, { ...CTX, networkName: 'Base Sepolia' }, { batchTx: TX })
    expect(outcome.ok && outcome.plan.request.url).toBe('https://x402.quicknode.com/base-sepolia/')
  })

  test('without a node on Arc it does not check the payment on another chain, or buy whatever says "payments"', () => {
    const noArc = catalog.filter((c) => c.path !== '/arc-testnet')
    expect(planJob('Did my last payment go through?', noArc, CTX, { batchTx: TX })).toMatchObject({
      ok: false,
      reason: 'NO_SELLER',
      why: 'I couldn’t find anyone who can do this job. The best of the 133 Arc listings, BotPay, matched only a payment word. Nothing was paid.',
    })
  })

  test('a seller Arkiv says stopped delivering is passed over for the next best', () => {
    const plain = rankJob('Get me a paid access receipt', catalog, { ...CTX, limit: 100_000n })
    expect(plain.pick?.candidate.path).toBe('/pay')
    const ranking = rankJob('Get me a paid access receipt', catalog, {
      ...CTX,
      limit: 100_000n,
      signals: new Map([['BotPay', { delivery: 'expired' as const }]]),
    })
    // Both BotPay listings are out, so the next best is the payment check on Arc.
    expect(ranking.pick?.candidate.sellerName).toBe('Quicknode')
  })

  test('a recent delivery is named in the reason', () => {
    const ranking = rankJob('Did my last payment go through?', catalog, {
      ...CTX,
      signals: new Map([['Quicknode', { delivery: 'live' as const }]]),
    })
    const outcome = decide('Did my last payment go through?', ranking, { batchTx: TX })
    expect(outcome.ok && outcome.plan.why).toBe(
      "Picked from 134 Arc listings: best match for 'payment', 0.0001 USDC, delivered recently",
    )
  })

  test('a sealing seller whose deposit does not cover the price is not paid', () => {
    const sealed: Candidate = {
      ...(catalog.find((c) => c.path === '/pay') as Candidate),
      resource: 'https://sealed.example.com/pay',
      sellerName: 'Sealed Co',
      sealedBy: `0x${'5'.repeat(40)}`,
    }
    const ranking = rankJob('Get me a paid access receipt', [...catalog, sealed], {
      ...CTX,
      signals: new Map([['Sealed Co', { covered: false }]]),
    })
    expect(ranking.ranked.find((r) => r.candidate.sellerName === 'Sealed Co')?.blocked).toBe('deposit')
    expect(ranking.pick?.candidate.sellerName).toBe('BotPay')
  })

  test('the planner source has no fixed path or payment pattern', () => {
    const source = readFileSync(path.join(import.meta.dirname, '../planner.ts'), 'utf8')
    expect(source).not.toMatch(/RELAY_PATH|PAYMENT_QUESTION|arc-testnet|quicknode|botpay/i)
  })
})
