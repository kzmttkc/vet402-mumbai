import { describe, expect, test } from 'bun:test'
import { custom } from 'viem'
import { createArkivReader } from '../../src/arkiv/readArkiv'
import { BUSY_LINE, blockToDate, buildRows, createReceiptsFeed } from '../../src/arkiv/receiptsFeed'
import type { FeedRow, RawRead, RawReceipt } from '../../src/arkiv/receiptsFeed'
import { receiptStatusLine } from '../../src/lib/receiptStatus'

const WRITER = '0x00000000000000000000000000000000000000aa'
const TX = `0x${'c'.repeat(64)}`

const timing = { currentBlock: 1000n, currentBlockTime: 1_793_000_000, blockDuration: 2 }

const payment = (over: Partial<RawReceipt> = {}): RawReceipt => ({
  key: '0xpayment',
  expiresAt: 1000n + 1_296_000n,
  kind: 'payment',
  seller: 'Seller X',
  amountMicro: 1000n,
  transferId: 'transfer-1',
  responseHash: 'f'.repeat(64),
  responseBytes: 42n,
  timesReceived: 1n,
  batchTx: null,
  paymentKey: null,
  ...over,
})

const read = (receipts: RawReceipt[]): RawRead => ({
  receipts,
  sellers: [{ seller: 'Seller X', expiresAt: 1000n + 302_400n }],
  timing,
})

const noStore = { load: (): FeedRow[] => [], save: () => undefined }

describe('Receipt rows', () => {
  test('dates come from the expiry block, in UTC', () => {
    // 2 seconds a block, so 43,200 blocks is one day.
    expect(blockToDate(1000n, timing)).toBe('2026-10-26')
    expect(blockToDate(1000n + 43_200n, timing)).toBe('2026-10-27')
  })

  test('a payment alone is accepted, with both expiry sentences', () => {
    const [row] = buildRows(read([payment()]))
    expect(row?.settled).toBe(false)
    expect(row?.amount).toBe('0.001')
    expect(row?.keptUntil).toBe(blockToDate(1000n + 1_296_000n, timing))
    expect(row?.sellerActiveUntil).toBe(blockToDate(1000n + 302_400n, timing))
    expect(receiptStatusLine('received', row?.batchTx ?? null)).toBe('Accepted. Not settled yet.')
  })

  test('a settlement moves its payment row on, and is not a row of its own', () => {
    const rows = buildRows(
      read([payment(), payment({ key: '0xsettlement', kind: 'settlement', batchTx: TX, paymentKey: '0xpayment' })]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.settled).toBe(true)
    expect(receiptStatusLine('completed', rows[0]?.batchTx ?? null)).toBe(`Settled in batch ${TX}`)
  })

  test('a seller with no live entity shows no seller line', () => {
    expect(buildRows({ receipts: [payment()], sellers: [], timing })[0]?.sellerActiveUntil).toBeNull()
  })

  test('rows from the live check stay off the screen', () => {
    expect(buildRows(read([payment({ seller: 'live-check-123' })]))).toHaveLength(0)
  })
})

describe('Reading at most once every 10 seconds', () => {
  test('a second refresh inside 10 seconds does not read', async () => {
    let clock = 0
    let reads = 0
    const feed = createReceiptsFeed(
      () => {
        reads++
        return Promise.resolve(read([payment()]))
      },
      noStore,
      () => clock,
    )
    await feed.refresh()
    clock = 9_999
    await feed.refresh()
    expect(reads).toBe(1)
    clock = 10_000
    await feed.refresh()
    expect(reads).toBe(2)
  })

  test('on HTTP 429 the saved rows stay, with the busy sentence', async () => {
    let clock = 0
    let fail = false
    const feed = createReceiptsFeed(
      () => (fail ? Promise.reject(Object.assign(new Error('429'), { status: 429 })) : Promise.resolve(read([payment()]))),
      noStore,
      () => clock,
    )
    const first = await feed.refresh()
    expect(first.rows).toHaveLength(1)
    expect(first.busy).toBe(false)

    fail = true
    clock = 10_000
    const second = await feed.refresh()
    expect(second.rows).toEqual(first.rows)
    expect(second.busy).toBe(true)
    expect(BUSY_LINE).toBe('Arkiv is busy. Showing saved rows.')

    fail = false
    clock = 20_000
    expect((await feed.refresh()).busy).toBe(false)
  })

  test('saved rows come back on the next visit', async () => {
    const saved = buildRows(read([payment()]))
    const feed = createReceiptsFeed(() => Promise.reject(new Error('no network')), {
      load: () => saved,
      save: () => undefined,
    })
    expect(feed.current().rows).toEqual(saved)
    const next = await feed.refresh()
    expect(next.rows).toEqual(saved)
    expect(next.busy).toBe(true)
  })
})

describe('The browser reader over a fake transport', () => {
  const attr = (name: string, type: string, value: unknown) => ({ name, type, value })

  test('takes the key from $key and each column from .value, with the writer filter on every query', async () => {
    const queries: string[] = []
    const transport = custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'arkiv_getBlockTiming') {
          return Promise.resolve({ current_block: 1000, current_block_time: 1_793_000_000, duration: 2 })
        }
        const [query] = params as [string]
        queries.push(query)
        if (query.includes("str('vet402_seller')")) {
          return Promise.resolve({
            blockNumber: '0x3e8',
            data: [
              {
                key: `0x${'2'.repeat(64)}`,
                expiresAt: '0x4e200',
                attributes: [attr('arkiv.schema', 'str', 'vet402_seller'), attr('seller', 'str', 'Seller X')],
              },
            ],
          })
        }
        return Promise.resolve({
          blockNumber: '0x3e8',
          data: [
            {
              key: `0x${'1'.repeat(64)}`,
              expiresAt: '0x13d620',
              attributes: [
                attr('arkiv.schema', 'str', 'vet402_receipt'),
                attr('kind', 'str', 'payment'),
                attr('seller', 'str', 'Seller X'),
                attr('amount_micro', 'u64', '0x3e8'),
                attr('gateway_transfer_id', 'str', 'transfer-1'),
                attr('response_hash', 'str', 'abc'),
                attr('response_bytes', 'u64', '0x2a'),
                attr('times_received', 'u64', '0x1'),
              ],
            },
          ],
        })
      },
    })

    const result = await createArkivReader(WRITER, transport)()

    // Payments, settlements, sellers and rulings, one page each.
    expect(queries).toHaveLength(4)
    for (const query of queries) expect(query.toLowerCase()).toContain(`$owner = addr(${WRITER})`)
    expect(result.receipts[0]?.key).toBe(`0x${'1'.repeat(64)}`)
    expect(result.receipts[0]?.amountMicro).toBe(1000n)
    expect(result.receipts[0]?.batchTx).toBeNull()
    expect(result.sellers[0]?.seller).toBe('Seller X')
    expect(result.timing.blockDuration).toBe(2)
  })
})
