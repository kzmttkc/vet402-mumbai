import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { receiptStatusLine } from '../../src/lib/receiptStatus'
import { toCandidate } from '../discovery'
import { createJobService } from '../jobs'
import type { JobPorts, PayOutcome, TransferInfo } from '../jobs'
import { createReceiptStore } from '../receiptStore'
import type { ReceiptRow } from '../receiptStore'
import { memoryStore } from './helpers'

// Files are only ever written inside a fresh temporary folder. Nothing here touches the app's data folder or .env.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'receipts-test-'))
  expect(realpathSync(dir).startsWith(realpathSync(os.tmpdir()))).toBe(true)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NETWORK = 'eip155:5042002'
const NONCE = `0x${'cd'.repeat(32)}`
const BATCH_TX = `0x${'ef'.repeat(32)}`

const row = (overrides: Partial<ReceiptRow> = {}): ReceiptRow => ({
  id: 'row-1',
  at: '2026-11-05T10:00:00.000Z',
  amount: '100',
  sellerName: 'Relay Co',
  responseHash: 'f'.repeat(64),
  responseBytes: 42,
  timesReceived: 1,
  transferId: 'transfer-1',
  nonce: NONCE,
  status: 'received',
  batchTx: null,
  ...overrides,
})

describe('The receipt file', () => {
  test('keeps rows newest first and updates them in place', () => {
    const store = createReceiptStore(dir)
    store.add(row({ id: 'a' }))
    store.add(row({ id: 'b' }))
    store.update('a', { status: 'completed', batchTx: BATCH_TX })

    const rows = createReceiptStore(dir).list()
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
    expect(rows[1]).toMatchObject({ status: 'completed', batchTx: BATCH_TX })
  })

  test('writes only inside the folder it was given', () => {
    createReceiptStore(dir).add(row())
    expect(readdirSync(dir)).toEqual(['receipts.json'])
  })

  test('ignores a damaged file and malformed rows', () => {
    writeFileSync(path.join(dir, 'receipts.json'), JSON.stringify([row(), { id: 1 }, 'x']))
    expect(createReceiptStore(dir).list()).toHaveLength(1)

    writeFileSync(path.join(dir, 'receipts.json'), 'not json')
    expect(createReceiptStore(dir).list()).toEqual([])
  })

  test('reads nothing from the app environment', () => {
    expect(process.env.BUYER_PRIVATE_KEY).toBeUndefined()
    expect(process.env.HOLD_PRIVATE_KEY).toBeUndefined()
  })
})

describe('Receipt status line', () => {
  test('is not settled while Gateway says received, batched or confirmed', () => {
    for (const status of ['received', 'batched', 'confirmed'] as const) {
      expect(receiptStatusLine(status, null)).toBe('Accepted. Not settled yet.')
      expect(receiptStatusLine(status, BATCH_TX)).toBe('Accepted. Not settled yet.')
    }
  })

  test('names the batch once Gateway says completed', () => {
    expect(receiptStatusLine('completed', BATCH_TX)).toBe(`Settled in batch ${BATCH_TX}`)
  })

  test('says nothing was charged when it failed', () => {
    expect(receiptStatusLine('failed', null)).toBe('Failed. Nothing was charged.')
  })
})

describe('Receipts from the job flow', () => {
  const relay = toCandidate(
    {
      resource: 'https://relay.example.com/arc-testnet/',
      type: 'http',
      accepts: [{ scheme: 'exact', network: NETWORK, amount: '100', extra: { name: 'GatewayWalletBatched' } }],
      metadata: {
        provider: { name: 'Relay Co', category: 'INFRASTRUCTURE' },
        path: '/arc-testnet',
        method: 'POST',
        siwx: true,
        input: { body: { required: ['jsonrpc', 'method'], properties: { jsonrpc: {}, method: {} } } },
      },
    },
    NETWORK,
  )
  if (!relay) throw new Error('fixture should be a candidate')

  const answer = { result: { status: '0x1' } }

  function setup(overrides: Partial<JobPorts> = {}) {
    const state = { transfer: { id: 'transfer-1', status: 'received', txHash: null } as TransferInfo, fetches: 0 }
    const outcome: PayOutcome = { data: answer, paid: 100n, nonce: NONCE, timesReceived: 1, transaction: '' }
    const ports: JobPorts = {
      candidates: () => Promise.resolve([relay]),
      latestReceipt: () => Promise.resolve({ batchTx: BATCH_TX }),
      holdAvailable: () => Promise.resolve(1_000_000n),
      pay: () => Promise.resolve(outcome),
      findTransfer: () => Promise.resolve(state.transfer),
      fetchTransfer: () => {
        state.fetches++
        return Promise.resolve(state.transfer)
      },
      ...overrides,
    }
    return { ports, state }
  }

  async function payOnce(ports: JobPorts, store = memoryStore()) {
    const jobs = createJobService(ports, store)
    const plan = await jobs.plan('did my payment go through')
    await jobs.approve(plan.id)
    return { jobs, store }
  }

  test('adds one row per payment with everything that came back', async () => {
    const { store } = await payOnce(setup().ports)

    const rows = store.list()
    expect(rows).toHaveLength(1)

    const body = JSON.stringify(answer)
    expect(rows[0]).toMatchObject({
      amount: '100',
      sellerName: 'Relay Co',
      responseHash: createHash('sha256').update(body).digest('hex'),
      responseBytes: Buffer.byteLength(body),
      timesReceived: 1,
      transferId: 'transfer-1',
      status: 'received',
      batchTx: null,
    })
  })

  test('hashes the answer exactly as it arrived', async () => {
    const raw = '{ "result":  {"status":"0x1"} }\n'
    const outcome: PayOutcome = { data: answer, body: raw, paid: 100n, nonce: NONCE, timesReceived: 1, transaction: '' }
    const { store } = await payOnce(setup({ pay: () => Promise.resolve(outcome) }).ports)

    expect(store.list()[0]).toMatchObject({
      responseHash: createHash('sha256').update(raw).digest('hex'),
      responseBytes: Buffer.byteLength(raw),
    })
  })

  test('adds nothing when the seller answered without charging', async () => {
    const free: PayOutcome = { data: answer, paid: 0n, nonce: null, timesReceived: 0, transaction: '' }
    const { store } = await payOnce(setup({ pay: () => Promise.resolve(free) }).ports)
    expect(store.list()).toHaveLength(0)
  })

  test('still keeps the receipt when the transfer cannot be found yet, then fills it in', async () => {
    const { ports, state } = setup({ findTransfer: () => Promise.reject(new Error('gateway slow')) })
    const { store } = await payOnce(ports)

    expect(store.list()[0]).toMatchObject({ transferId: null, status: 'received' })

    // Gateway catches up: the row is found by its nonce on the next refresh.
    const found = setup({ findTransfer: () => Promise.resolve(state.transfer) })
    const refreshed = createJobService(found.ports, store)
    expect((await refreshed.listReceipts())[0]).toMatchObject({ transferId: 'transfer-1' })
  })

  test('follows Gateway from received to completed, then stops asking', async () => {
    const { ports, state } = setup()
    const { jobs } = await payOnce(ports)

    state.transfer = { id: 'transfer-1', status: 'batched', txHash: null }
    expect((await jobs.listReceipts())[0]).toMatchObject({ status: 'batched', batchTx: null })

    state.transfer = { id: 'transfer-1', status: 'confirmed', txHash: BATCH_TX }
    expect((await jobs.listReceipts())[0]?.status).toBe('confirmed')

    state.transfer = { id: 'transfer-1', status: 'completed', txHash: BATCH_TX }
    expect((await jobs.listReceipts())[0]).toMatchObject({ status: 'completed', batchTx: BATCH_TX })

    const before = state.fetches
    await jobs.listReceipts()
    expect(state.fetches).toBe(before)
  })

  test('keeps the last known status when Gateway cannot be reached', async () => {
    const { ports } = setup()
    const { store } = await payOnce(ports)

    const offline = createJobService(
      { ...ports, fetchTransfer: () => Promise.reject(new Error('offline')) },
      store,
    )
    expect((await offline.listReceipts())[0]?.status).toBe('received')
  })

  test('never sends the nonce to the browser', async () => {
    const { jobs } = await payOnce(setup().ports)
    const view = (await jobs.listReceipts())[0]
    expect(view).toBeDefined()
    expect(Object.keys(view ?? {}).sort()).toEqual([
      'amount',
      'at',
      'batchTx',
      'comparison',
      'demo',
      'id',
      'outcome',
      'responseBytes',
      'responseHash',
      'sellerName',
      'status',
      'timesReceived',
      'transferId',
    ])
  })

  test('saves receipts to the file store when given one', async () => {
    const store = createReceiptStore(dir)
    await payOnce(setup().ports, store)

    const saved = JSON.parse(readFileSync(path.join(dir, 'receipts.json'), 'utf8')) as ReceiptRow[]
    expect(saved).toHaveLength(1)
    expect(saved[0]?.sellerName).toBe('Relay Co')
  })
})
