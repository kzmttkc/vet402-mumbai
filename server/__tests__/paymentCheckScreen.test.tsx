import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SealedLines, SpendQuestion } from '../../src/components/AskAgent'
import { CATALOG_CARD_LINE, circleCardLine, OWN_CARD_LINE } from '../../src/lib/askAgent'
import { OWN_SELLER_MARK, PlanWhy } from '../../src/components/PlanWhy'
import { answerChecked, DELIVERED_SEALED, KEY_CHECKED, PAYMENT_CHECK_NAME } from '../paymentCheckSeller'
import { DEMO_PRICE } from '../sellers'
import { limitLine, PROTECTED_LINE, TRY_JOB_LIMIT } from '../tryJob'

// What "Ask the agent" shows for vet402 Payment Check: the mark on the card, the protection line, and the sealed receipt.

describe('the screen for vet402 Payment Check', () => {
  test('the approval question has the protection line only when the plan carries it', () => {
    const shielded = renderToStaticMarkup(<SpendQuestion plan={{ amount: '0.001', protection: PROTECTED_LINE }} />)
    expect(shielded).toContain('May I spend up to <span class="tabular-nums">0.001 USDC</span> on this job?')
    expect(shielded).toContain("Protected on Arc: if the answer goes missing, the seller&#x27;s deposit pays you back.")

    const plain = renderToStaticMarkup(<SpendQuestion plan={{ amount: '0.0001' }} />)
    expect(plain).toContain('0.0001 USDC')
    expect(plain).not.toContain('Protected on Arc')
  })

  test('the limit line sits under the question, before the protection line', () => {
    const line = limitLine(TRY_JOB_LIMIT)
    const html = renderToStaticMarkup(<SpendQuestion plan={{ amount: '0.001', protection: PROTECTED_LINE, limitLine: line }} />)
    expect(html).toContain('Each job can spend at most 0.01 USDC.')
    expect(html.indexOf('on this job?')).toBeLessThan(html.indexOf('Each job can spend'))
    expect(html.indexOf('Each job can spend')).toBeLessThan(html.indexOf('Protected on Arc'))
    expect(renderToStaticMarkup(<SpendQuestion plan={{ amount: '0.001' }} />)).not.toContain('Each job can spend')
  })

  test('the receipt says the answer was checked and what was paid, and the seal and the key are under Details', () => {
    const html = renderToStaticMarkup(
      <SealedLines lines={[answerChecked(DEMO_PRICE), `Detail: ${DELIVERED_SEALED}`, `Detail: ${KEY_CHECKED}`]} />,
    )
    const [body, details] = html.split('<details')
    expect(body).toContain('Answer received and checked. You paid 0.001 USDC once.')
    expect(body).not.toMatch(/key|seal/i)
    expect(details).toContain('Delivered sealed. Key checked against the seller&#x27;s promise.')
  })

  test('the compared list marks vet402 own seller, and only it', () => {
    const html = renderToStaticMarkup(
      <PlanWhy
        compared={[
          { sellerName: PAYMENT_CHECK_NAME, listing: 'payment-check', amount: '0.001', note: 'Picked', own: true },
          { sellerName: 'Quicknode', listing: 'arc-testnet', amount: '0.0001', note: 'Lower match' },
        ]}
      />,
    )
    expect(html.split(OWN_SELLER_MARK.replace("'", '&#x27;')).length - 1).toBe(1)
  })

  test('the receipt reads in plain words first, with the key check under Details', () => {
    const html = renderToStaticMarkup(<SealedLines lines={[DELIVERED_SEALED, `Detail: ${KEY_CHECKED}`]} />)
    expect(html).toContain('Delivered sealed. Key checked against the seller&#x27;s promise.')
    expect(html).toContain('<summary class="cursor-pointer select-none font-semibold">Details</summary>')
    expect(html.indexOf('Details')).toBeGreaterThan(html.indexOf('Delivered sealed'))
    expect(html).not.toContain('Detail: ')
    expect(renderToStaticMarkup(<SealedLines />)).toBe('')
  })
})

describe('the Circle line on the approval card', () => {
  const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()

  test('a seller from the catalog says it was found in Circle Discovery and paid with Arc Nanopayments', () => {
    const text = textOf(renderToStaticMarkup(<SpendQuestion plan={{ amount: '0.0001', limitLine: limitLine(TRY_JOB_LIMIT) }} />))
    expect(text).toContain(CATALOG_CARD_LINE)
    expect(CATALOG_CARD_LINE).toBe("Found in Circle's Discovery catalog, paid with Arc Nanopayments.")
    expect(text).not.toContain(OWN_CARD_LINE)
    expect(text.indexOf('on this job?')).toBeLessThan(text.indexOf(CATALOG_CARD_LINE))
  })

  test("vet402's own seller says it was ranked beside the catalog, not found in it", () => {
    const text = textOf(renderToStaticMarkup(<SpendQuestion plan={{ amount: '0.001', own: true, protection: PROTECTED_LINE }} />))
    expect(text).toContain(OWN_CARD_LINE)
    expect(OWN_CARD_LINE).toBe("Ranked beside Circle's Discovery catalog, paid with Arc Nanopayments.")
    expect(text).not.toContain('Found in')
    expect(text.indexOf(OWN_CARD_LINE)).toBeLessThan(text.indexOf('Protected on Arc'))
    expect(circleCardLine(true)).toBe(OWN_CARD_LINE)
    expect(circleCardLine(undefined)).toBe(CATALOG_CARD_LINE)
  })

  test('both lines keep to the wording rules', () => {
    for (const line of [CATALOG_CARD_LINE, OWN_CARD_LINE]) {
      expect(line).not.toMatch(/\b(we|our|us)\b/i)
      expect(line).not.toMatch(/[;\u2013\u2014-]/)
    }
  })
})
