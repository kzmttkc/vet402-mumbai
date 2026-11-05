import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckReceipt } from '../../src/components/CheckReceipt'
import { ReceiptList } from '../../src/components/ReceiptList'
import { PublicApp } from '../../src/PublicApp'
import { joinStatic, loadCheckFile, loadReceipts, STATIC_PATHS } from '../../src/lib/publicData'
import type { PublicReceiptsFile, PublicStatusesFile, ReceiptView } from '../../src/lib/publicData'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).__ARKIV_WRITER__ = ''
})

const ROOT = path.resolve(import.meta.dirname, '../..')

const list: PublicReceiptsFile = {
  receipts: [
    {
      ref: 'r0',
      amount: '0.001',
      sellerName: 'Seller A',
      responseHash: 'f'.repeat(64),
      responseBytes: 42,
      transferId: 'transfer-1',
      outcome: ['Charged once. Delivered.'],
    },
  ],
}
const statuses: PublicStatusesFile = { statuses: { r0: { status: 'completed', batchTx: `0x${'e'.repeat(64)}` } } }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
/** What a published host does with /api: it answers with the page. */
const page = () => new Response('<!doctype html><title>vet402</title>', { headers: { 'content-type': 'text/html' } })

const host = (api: () => Response | Promise<Response>, files: Record<string, unknown> | null) =>
  (async (url: string) => {
    if (url === '/api/receipts') return api()
    if (!files || !(url in files)) return page()
    return json(files[url])
  }) as unknown as typeof fetch

const exported = { [STATIC_PATHS.receipts]: list, [STATIC_PATHS.statuses]: statuses }

describe('loadReceipts', () => {
  test('uses /api when it answers with JSON', async () => {
    const api = json({ receipts: [{ id: 'live' }] })
    const loaded = await loadReceipts(host(() => api, exported))
    expect(loaded?.source).toBe('api')
    expect(loaded?.receipts[0]?.id).toBe('live')
  })

  test.each([
    ['answers with the page', page],
    ['answers 404', () => new Response('nope', { status: 404 })],
    ['answers a JSON error', () => json({ error: 'broken' }, 500)],
    ['answers JSON of another shape', () => json({ hello: 'world' })],
    [
      'cannot be reached',
      () => {
        throw new Error('network down')
      },
    ],
  ] as const)('switches to the exported files when /api %s', async (_name, api) => {
    const loaded = await loadReceipts(host(api, exported))
    expect(loaded?.source).toBe('static')
    expect(loaded?.receipts).toHaveLength(1)
    expect(loaded?.receipts[0]).toMatchObject({ sellerName: 'Seller A', status: 'completed', transferId: 'transfer-1' })
  })

  test('null when neither can be read, so the screen keeps what it has', async () => {
    expect(await loadReceipts(host(page, null))).toBeNull()
  })
})

describe('loadCheckFile', () => {
  test('reads the event payment', async () => {
    const file = { eventNonce: '0xabc', eventTransferId: 'transfer-1' }
    expect(await loadCheckFile(host(page, { [STATIC_PATHS.check]: file }))).toEqual(file)
  })

  test('no export means no event payment, without an error', async () => {
    expect(await loadCheckFile(host(page, null))).toEqual({ eventNonce: null, eventTransferId: null })
  })
})

describe('the published screen', () => {
  const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

  test('shows the static receipts, and offers no button on them', () => {
    const html = renderToStaticMarkup(
      <ReceiptList receipts={joinStatic(list, statuses)} onRetryAsNew={() => {}} busy={false} />,
    )
    expect(html).toContain('Seller A')
    expect(html).toContain('0.001 USDC')
    expect(html).toContain('Settled in batch')
    expect(html).toContain('Charged once. Delivered.')
    expect(html).not.toContain('<button')
    // The static files do not carry it, so the row leaves it out instead of guessing.
    expect(html).not.toContain('Received')
  })

  test('a row from the backend still shows how many times it was received', () => {
    const live: ReceiptView = { ...joinStatic(list, statuses)[0]!, timesReceived: 2 }
    expect(renderToStaticMarkup(<ReceiptList receipts={[live]} onRetryAsNew={() => {}} busy={false} />)).toContain('2 times')
  })

  test('the panel is prefilled and has the pre-event payment', () => {
    const html = renderToStaticMarkup(<CheckReceipt />)
    expect(html).toContain('Check a receipt')
    expect(html).toContain('Pre-event payment')
    expect(html).toContain('value="0x85913b5ba5510e03258433ca51c7e9a6e3a4c972766eb9964ba900ceb33aa304"')
  })

  test('the screen text names no wallet, gas, signature, chain or address', () => {
    const rows = renderToStaticMarkup(
      <ReceiptList receipts={joinStatic(list, statuses)} onRetryAsNew={() => {}} busy={false} />,
    )
    const text = `${textOf(renderToStaticMarkup(<PublicApp />))} ${textOf(rows)}`
    expect(text).toContain('Check a receipt')
    expect(text).not.toMatch(/wallet|\bgas\b|signature|\barc\b|ethereum|\bbase\b|polygon|solana|0x[0-9a-f]{40}(?![0-9a-f])/i)
  })
})

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as {
    rewrites: { source: string; destination: string }[]
  }

  test('has one rule and nothing else', () => {
    expect(Object.keys(config)).toEqual(['rewrites'])
    expect(config.rewrites).toHaveLength(1)
    expect(config.rewrites[0]?.destination).toBe('/index.html')
  })

  test('the rule takes every path except /assets', () => {
    const source = new RegExp(`^${config.rewrites[0]?.source}$`)
    for (const hit of ['/', '/api/receipts', '/some/page', '/assetsish', '/receipts.html']) expect(source.test(hit)).toBe(true)
    for (const miss of ['/assets/index.js', '/assets/a/b.css']) expect(source.test(miss)).toBe(false)
  })
})
