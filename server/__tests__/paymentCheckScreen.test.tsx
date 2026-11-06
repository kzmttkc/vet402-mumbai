import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SealedLines, SpendQuestion } from '../../src/components/AskAgent'
import { OWN_SELLER_MARK, PlanWhy } from '../../src/components/PlanWhy'
import { DELIVERED_SEALED, KEY_CHECKED, PAYMENT_CHECK_NAME } from '../paymentCheckSeller'
import { PROTECTED_LINE } from '../tryJob'

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
