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

const render = (world: WorldApproval, amount = '1') =>
  renderToStaticMarkup(<WorldHoldActions world={world} amount={amount} text={amount} busy={false} />)

const SELFIE_LINE = 'This hold is above 0.5 USDC, so World App will also ask for a selfie check.'
const SELFIE_UNAVAILABLE =
  'Not approved: this hold needs a selfie check, which World App could not give right now. Nothing was held.'
// Ready to hold: a budget with room, no request open.
const readyWorld = waitingWorld({ request: null, budgetLeft: '5', selfieAbove: '0.5' })

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

describe('the selfie check on the card', () => {
  test('a hold above 0.5 USDC says, before the QR code, that World App will also ask for a selfie check', () => {
    const html = render(readyWorld, '1')
    expect(html).toContain(SELFIE_LINE)
    expect(html).toContain('Hold 1 USDC for your agent')
  })

  test('a hold at or below the line says nothing extra', () => {
    for (const amount of ['0.5', '0.2']) expect(render(readyWorld, amount)).not.toContain('selfie')
  })

  test('a new budget is not a hold, so it says nothing about a selfie check', () => {
    const html = render(waitingWorld({ request: null, budgetSet: false, budgetLeft: null, selfieAbove: '0.5' }), '3')
    expect(html).toContain('Set budget 3 USDC')
    expect(html).not.toContain('selfie')
  })

  test('while a hold with a selfie check waits, the line stays next to the QR code', () => {
    const html = render(
      waitingWorld({
        selfieAbove: '0.5',
        qr: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E',
        request: { id: 'hold_2', kind: 'hold', state: 'waiting', message: 'Waiting for approval in World ID.', selfie: true },
      }),
    )
    expect(html).toContain(SELFIE_LINE)
    expect(html).toContain('Scan with World App on your phone')
  })

  test('when World App cannot give the selfie check, the card reads why and that nothing was held', () => {
    const html = render(
      waitingWorld({
        selfieAbove: '0.5',
        request: { id: 'hold_2', kind: 'hold', state: 'closed', message: SELFIE_UNAVAILABLE, selfie: true },
      }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain(SELFIE_UNAVAILABLE)
    expect(html).not.toContain('<img')
  })
})
