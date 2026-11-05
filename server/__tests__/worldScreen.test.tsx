import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorldHoldActions } from '../../src/components/WorldHoldActions'
import type { WorldApproval } from '../../src/hooks/useWorldApproval'
import { presentRequest } from '../../src/lib/worldRequestQr'

// A made-up request URL in the shape IDKit returns. Nothing here reaches World.
const URI = 'https://world.org/verify?t=wld&i=00000000-1111-2222-3333-444444444444&k=c2VjcmV0LWtleS1mb3ItdGhpcy10ZXN0'

const waitingWorld = (change: Partial<WorldApproval>): WorldApproval =>
  ({
    loaded: true,
    enabled: true,
    budgetSet: true,
    hasLastApproval: false,
    request: { id: 'hold_1', kind: 'hold', state: 'waiting', message: 'Waiting for approval in World ID.' },
    canCopy: false,
    qr: null,
    error: null,
    setBudget: () => Promise.resolve(),
    hold: () => Promise.resolve(),
    copy: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    useLastApproval: () => Promise.resolve(),
    ...change,
  }) as WorldApproval

const render = (world: WorldApproval) =>
  renderToStaticMarkup(<WorldHoldActions world={world} amount="1" text="1" busy={false} />)

describe('how the request is offered', () => {
  test('staging keeps the copy button and makes no QR code', async () => {
    expect(await presentRequest('staging', URI)).toEqual({ kind: 'copy' })
  })

  test('production makes a QR code image whose markup does not carry the URL as text', async () => {
    const shown = await presentRequest('production', URI)
    if (shown.kind !== 'qr') throw new Error('expected a QR code')
    expect(shown.image.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    const svg = decodeURIComponent(shown.image.slice(shown.image.indexOf(',') + 1))
    expect(svg).toStartWith('<svg')
    expect(svg).toContain('<path')
    for (const piece of [URI, 'world.org', 'verify', 'c2VjcmV0']) expect(shown.image + svg).not.toContain(piece)
    // A different request makes a different code.
    const other = await presentRequest('production', `${URI}x`)
    expect(other).not.toEqual(shown)
  })
})

describe('what the screen shows while waiting', () => {
  test('production shows the QR code and a short line, never the URL or the copy button', async () => {
    const shown = await presentRequest('production', URI)
    if (shown.kind !== 'qr') throw new Error('expected a QR code')
    const html = render(waitingWorld({ qr: shown.image }))
    expect(html).toContain('<img')
    expect(html).toContain('alt="QR code for this approval request"')
    expect(html).toContain('Scan with World App on your phone')
    expect(html).not.toContain('Copy the simulator request')
    for (const piece of [URI, 'world.org', 'verify?', 'c2VjcmV0']) expect(html).not.toContain(piece)
  })

  test('staging is unchanged: the copy button, no QR code', () => {
    const html = render(waitingWorld({ canCopy: true }))
    expect(html).toContain('Copy the simulator request')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('Scan with World App')
    expect(html).toContain('Cancel request')
  })

  test('once the request ends the QR code is gone', () => {
    const html = render(
      waitingWorld({
        qr: null,
        request: { id: 'hold_1', kind: 'hold', state: 'closed', message: 'Not approved. Nothing was held or paid.' },
      }),
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('Not approved. Nothing was held or paid.')
  })
})
