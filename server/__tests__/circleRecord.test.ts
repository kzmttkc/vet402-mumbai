import { describe, expect, test } from 'bun:test'
import {
  countNonces,
  fetchTransfers,
  isOnePayment,
  readComparison,
  readOnePayment,
  RECORD_ATTEMPTS,
  RECORD_DELAY_MS,
} from '../circleRecord'
import type { ExpectedPayment, Transfer } from '../circleRecord'

// Fake network and fake clock: nothing is fetched, nothing is waited for, and no file is touched.

const SELLER = '0xAbCdEf0000000000000000000000000000000001'
const PAYER = '0xAbCdEf0000000000000000000000000000000002'
const NONCE = `0x${'ab'.repeat(32)}`
const expected: ExpectedPayment = { seller: SELLER, payer: PAYER, amount: '1000' }

const transfer = (overrides: Partial<Transfer> = {}): Transfer => ({
  id: 't1',
  status: 'received',
  toAddress: SELLER.toLowerCase(),
  fromAddress: PAYER.toUpperCase().replace('0X', '0x'),
  amount: '1000',
  nonce: NONCE,
  ...overrides,
})

const json = (body: unknown): Response => Response.json(body)

describe('Reading Circle’s record', () => {
  test('asks for exactly the nonce, on the testnet host', async () => {
    const urls: string[] = []
    const fetchImpl = ((url: string) => {
      urls.push(url)
      return Promise.resolve(json({ transfers: [transfer()] }))
    }) as unknown as typeof fetch

    await fetchTransfers(`nonce=${NONCE}`, fetchImpl)

    expect(urls).toEqual([`https://gateway-api-testnet.circle.com/v1/x402/transfers?nonce=${NONCE}`])
  })

  test('accepts exactly one good transfer, comparing addresses in lowercase', () => {
    expect(isOnePayment([transfer()], expected)).toBe(true)
    expect(isOnePayment([transfer({ status: 'completed' })], expected)).toBe(true)
  })

  test.each([
    ['no transfer', []],
    ['two transfers', [transfer(), transfer({ id: 't2' })]],
    ['a failed transfer', [transfer({ status: 'failed' })]],
    ['a different seller', [transfer({ toAddress: '0x0000000000000000000000000000000000000009' })]],
    ['a different payer', [transfer({ fromAddress: '0x0000000000000000000000000000000000000009' })]],
    ['another amount', [transfer({ amount: '1001' })]],
    ['an amount that is not the integer string', [transfer({ amount: 1000 })]],
    ['an amount with decimals', [transfer({ amount: '0.001' })]],
    ['no status', [transfer({ status: undefined })]],
  ])('rejects %s', (_name, transfers) => {
    expect(isOnePayment(transfers, expected)).toBe(false)
  })

  test('tries up to 5 times, 2 seconds apart, and stops when the record is right', async () => {
    const delays: number[] = []
    let reads = 0
    const fetchImpl = (() => {
      reads++
      return Promise.resolve(json({ transfers: reads < 3 ? [] : [transfer()] }))
    }) as unknown as typeof fetch

    const result = await readOnePayment(NONCE, expected, {
      fetchImpl,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    expect(result.ok).toBe(true)
    expect(reads).toBe(3)
    expect(delays).toEqual([2000, 2000])
  })

  test('gives up after 5 reads and says it could not confirm', async () => {
    const delays: number[] = []
    let reads = 0
    const fetchImpl = (() => {
      reads++
      return Promise.reject(new Error('offline'))
    }) as unknown as typeof fetch

    const result = await readOnePayment(NONCE, expected, {
      fetchImpl,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    expect(result).toEqual({ ok: false, transfer: null })
    expect(reads).toBe(RECORD_ATTEMPTS)
    expect(RECORD_ATTEMPTS).toBe(5)
    expect(RECORD_DELAY_MS).toBe(2000)
    expect(delays).toEqual([2000, 2000, 2000, 2000])
  })
})

describe('Reading the record by payer and seller', () => {
  const first = `0x${'11'.repeat(32)}`
  const second = `0x${'22'.repeat(32)}`
  const other = `0x${'33'.repeat(32)}`

  test('counts only the rows whose nonce is one of the two', () => {
    const rows = [transfer({ nonce: first }), transfer({ nonce: second }), transfer({ nonce: other })]
    expect(countNonces(rows, [first, second])).toBe(2)
    expect(countNonces([transfer({ nonce: other })], [first, second])).toBe(0)
  })

  test('asks by payer and seller, waits until both are there, and counts two', async () => {
    const urls: string[] = []
    let reads = 0
    const fetchImpl = ((url: string) => {
      urls.push(url)
      reads++
      const rows = reads < 2 ? [transfer({ nonce: first })] : [transfer({ nonce: first }), transfer({ nonce: second }), transfer({ nonce: other })]
      return Promise.resolve(json({ transfers: rows }))
    }) as unknown as typeof fetch

    const count = await readComparison(PAYER, SELLER, [first, second], { fetchImpl, sleep: () => Promise.resolve() })

    expect(count).toBe(2)
    expect(urls[0]).toBe(`https://gateway-api-testnet.circle.com/v1/x402/transfers?from=${PAYER}&to=${SELLER}`)
  })

  test('reports fewer than two when the second never shows up', async () => {
    let reads = 0
    const fetchImpl = (() => {
      reads++
      return Promise.resolve(json({ transfers: [transfer({ nonce: first })] }))
    }) as unknown as typeof fetch

    const count = await readComparison(PAYER, SELLER, [first, second], { fetchImpl, sleep: () => Promise.resolve() })

    expect(count).toBe(1)
    expect(reads).toBe(5)
  })
})
