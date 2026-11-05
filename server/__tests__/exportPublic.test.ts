import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ReceiptRow } from '../receiptStore'
import { exportPublic, pickEventPayment } from '../../scripts/export-public'
import { joinStatic } from '../../src/lib/publicData'
import { COMPARISON_LINE } from '../../src/lib/receiptStatus'

const PAYER = `0x${'a1'.repeat(20)}`
const FAKE_KEY = `0x${'b2'.repeat(32)}`
const EVENT_NONCE = `0x${'c3'.repeat(32)}`
const OTHER_NONCE = `0x${'d4'.repeat(32)}`
const COMPARE_NONCE = `0x${'d5'.repeat(32)}`
const BATCH = `0x${'e5'.repeat(32)}`

const row = (over: Partial<ReceiptRow> = {}): ReceiptRow & Record<string, unknown> => ({
  id: 'local-id',
  at: '2026-11-06T00:00:00.000Z',
  amount: '1000',
  sellerName: 'Seller A',
  responseHash: 'f'.repeat(64),
  responseBytes: 42,
  timesReceived: 1,
  transferId: 'transfer-a',
  nonce: OTHER_NONCE,
  status: 'received',
  batchTx: null,
  // Fields the export must never carry, whatever the row holds.
  arkivPaymentKey: FAKE_KEY,
  arkivSettlementKey: FAKE_KEY,
  payer: PAYER,
  privateKey: FAKE_KEY,
  ...over,
})

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'export-public-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const run = (rows: unknown) => {
  const dataDir = tempDir()
  const outDir = tempDir()
  writeFileSync(path.join(dataDir, 'receipts.json'), JSON.stringify(rows))
  const summary = exportPublic({ dataDir, outDir })
  const read = (name: string) => readFileSync(path.join(outDir, name), 'utf8')
  return { summary, outDir, receipts: read('receipts.json'), statuses: read('statuses.json'), check: read('check.json') }
}

const rows = [
  row({ transferId: 'transfer-new', nonce: OTHER_NONCE, status: 'received', sellerName: 'Seller B' }),
  row({ transferId: 'transfer-event', nonce: EVENT_NONCE, status: 'completed', batchTx: BATCH, outcome: ['Charged once. Delivered.'], demo: 'a' }),
  row({ transferId: 'transfer-compare', nonce: COMPARE_NONCE, status: 'completed', comparison: true, demo: 'compare', outcome: ['Circle record: 2 transfers. Charged twice.'] }),
]

describe('exportPublic', () => {
  test('writes only the allowed fields of a receipt', () => {
    const { receipts } = run(rows)
    const parsed = JSON.parse(receipts) as { receipts: Record<string, unknown>[] }
    expect(Object.keys(parsed.receipts[1] ?? {}).sort()).toEqual(
      ['amount', 'outcome', 'ref', 'responseBytes', 'responseHash', 'sellerName', 'transferId'].sort(),
    )
    expect(parsed.receipts[1]).toMatchObject({
      amount: '0.001',
      sellerName: 'Seller A',
      responseHash: 'f'.repeat(64),
      responseBytes: 42,
      transferId: 'transfer-event',
      outcome: ['Charged once. Delivered.'],
    })
  })

  test('writes the status and batch tx of every row', () => {
    const { statuses } = run(rows)
    expect(JSON.parse(statuses)).toEqual({
      statuses: {
        r0: { status: 'received', batchTx: null },
        r1: { status: 'completed', batchTx: BATCH },
        r2: { status: 'completed', batchTx: null },
      },
    })
  })

  test('no address, key or local id, and no nonce but the event payment', () => {
    const { receipts, statuses, check } = run(rows)
    const all = receipts + statuses + check
    for (const secret of [PAYER, FAKE_KEY, OTHER_NONCE, COMPARE_NONCE, 'local-id', '2026-11-06']) expect(all).not.toContain(secret)
    expect(receipts + statuses).not.toContain(EVENT_NONCE)
    expect(JSON.parse(check)).toEqual({ eventNonce: EVENT_NONCE, eventTransferId: 'transfer-event' })
  })

  test('a comparison row keeps its warning, as a result sentence', () => {
    const { receipts, statuses } = run(rows)
    const view = joinStatic(JSON.parse(receipts), JSON.parse(statuses))
    expect(view[2]?.outcome).toEqual(['Circle record: 2 transfers. Charged twice.', COMPARISON_LINE])
    expect(view[1]?.outcome).not.toContain(COMPARISON_LINE)
  })

  test('an address hiding in free text stops the export before any file is written', () => {
    const outDir = tempDir()
    const dataDir = tempDir()
    writeFileSync(path.join(dataDir, 'receipts.json'), JSON.stringify([row({ sellerName: `Seller ${PAYER}` })]))
    expect(() => exportPublic({ dataDir, outDir })).toThrow('long hex')
    expect(existsSync(path.join(outDir, 'receipts.json'))).toBe(false)
  })

  test('a missing, broken or empty receipts file stops the export', () => {
    const outDir = tempDir()
    const dataDir = tempDir()
    expect(() => exportPublic({ dataDir, outDir })).toThrow('does not exist')
    writeFileSync(path.join(dataDir, 'receipts.json'), '{not json')
    expect(() => exportPublic({ dataDir, outDir })).toThrow()
    writeFileSync(path.join(dataDir, 'receipts.json'), '[]')
    expect(() => exportPublic({ dataDir, outDir })).toThrow('no receipts')
    writeFileSync(path.join(dataDir, 'receipts.json'), JSON.stringify([row(), { id: 'half a row' }]))
    expect(() => exportPublic({ dataDir, outDir })).toThrow('not valid')
    expect(existsSync(path.join(outDir, 'receipts.json'))).toBe(false)
  })
})

describe('pickEventPayment', () => {
  test('the newest settled payment comes first', () => {
    expect(pickEventPayment(rows)?.transferId).toBe('transfer-event')
  })

  test('with none settled, the newest that did not fail', () => {
    expect(pickEventPayment([row({ status: 'failed' }), row({ transferId: 'transfer-b' })])?.transferId).toBe('transfer-b')
  })

  test('never a comparison row, a failed row, or a row with no nonce', () => {
    expect(
      pickEventPayment([row({ comparison: true, status: 'completed' }), row({ status: 'failed' }), row({ nonce: null })]),
    ).toBeNull()
  })
})
