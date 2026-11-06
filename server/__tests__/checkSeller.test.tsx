import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { custom } from 'viem'
import { SellerAnswerView } from '../../src/arkiv/CheckSeller'
import { createArkivReader, createRulingsReader } from '../../src/arkiv/readArkiv'
import { blockToDate } from '../../src/arkiv/receiptsFeed'
import {
  ARC_TX,
  CLEAR_LINE,
  checkSeller,
  NOT_ADDRESS_LINE,
  notPaidLine,
  RULING_SECONDS,
  rulingLine,
  UNREAD_LINE,
} from '../../src/arkiv/sellerCheck'
import type { SellerAnswer } from '../../src/arkiv/sellerCheck'

const WRITER = '0x00000000000000000000000000000000000000aa'
const PAY_TO = '0xB9a6F77d9EFDFcF165e1259fC650fFA01b06B80D'
const PAY_TO_LOWER = PAY_TO.toLowerCase()
const OTHER = `0x${'5e'.repeat(20)}`
const CLAIM_ID = `0x${'12'.repeat(32)}`
const CLAIM_TX = `0x${'3c'.repeat(32)}`

// 2 seconds a block, so 302,400 blocks is 7 days.
const CURRENT_BLOCK = 1_000_000
const TIMING = { current_block: CURRENT_BLOCK, current_block_time: 1_793_000_000, duration: 2 }
const timing = { currentBlock: BigInt(CURRENT_BLOCK), currentBlockTime: TIMING.current_block_time, blockDuration: 2 }

const attr = (name: string, type: string, value: string) => ({ name, type, value })

interface Ruling {
  createdAt: number
  verdict?: string
  /** Absent on an entity written before `pay_to` existed. */
  payTo?: string
  seller?: string
  claimTx?: string
}

const entity = (r: Ruling, i: number) => ({
  key: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  createdAt: `0x${r.createdAt.toString(16)}`,
  attributes: [
    attr('arkiv.schema', 'str', 'vet402_verdict'),
    attr('kind', 'str', 'verdict'),
    attr('claim_id', 'str', CLAIM_ID),
    attr('seller', 'str', r.seller ?? PAY_TO_LOWER),
    attr('verdict', 'str', r.verdict ?? 'silent'),
    ...(r.payTo ? [attr('pay_to', 'str', r.payTo)] : []),
    ...(r.claimTx ? [attr('claim_tx', 'str', r.claimTx)] : []),
  ],
})

/** A Rabdi node that holds these rulings, or one that refuses every call. */
function node(rulings: Ruling[] | 'down') {
  const calls: string[] = []
  const transport = custom({
    request: ({ method, params }: { method: string; params?: unknown }) => {
      calls.push(method === 'arkiv_query' ? (params as [string])[0] : method)
      if (rulings === 'down') return Promise.reject(new Error('HTTP 429'))
      if (method === 'arkiv_getBlockTiming') return Promise.resolve(TIMING)
      if (method === 'arkiv_query') return Promise.resolve({ data: rulings.map(entity), blockNumber: `0x${CURRENT_BLOCK.toString(16)}` })
      return Promise.reject(new Error(`unexpected ${method}`))
    },
  })
  return { read: createRulingsReader(WRITER, transport), calls }
}

const ruled = (answer: SellerAnswer) => {
  if (answer.kind !== 'ruled') throw new Error(`expected a ruling, got ${answer.kind}`)
  return answer
}

describe('Check a seller: the four answers', () => {
  test('a ruling in the last 7 days names the date, the verdict, the claim on Arc and the date vet402 pays again', async () => {
    const createdAt = CURRENT_BLOCK - 43_200
    const { read } = node([{ createdAt, verdict: 'fraud', payTo: PAY_TO_LOWER, claimTx: CLAIM_TX }])
    const answer = ruled(await checkSeller(PAY_TO, read))
    const date = blockToDate(BigInt(createdAt), timing)
    expect(rulingLine(answer)).toBe(`Arc ruled against this seller on ${date} (Fraud). Claim 0x12121212… on Arc.`)
    expect(answer.claimUrl).toBe(`${ARC_TX}${CLAIM_TX}`)
    expect(answer.claimUrl).toStartWith('https://explorer.testnet.arc.io/tx/0x')
    expect(answer.notPaidUntil).toBe(blockToDate(BigInt(createdAt + RULING_SECONDS / 2), timing))

    const html = renderToStaticMarkup(<SellerAnswerView answer={answer} />)
    expect(html).toContain(`href="${ARC_TX}${CLAIM_TX}"`)
    expect(html).toContain(notPaidLine(answer.notPaidUntil!))
  })

  test('a ruling older than 7 days is still shown, without the line about paying', async () => {
    const { read } = node([{ createdAt: CURRENT_BLOCK - 302_400, payTo: PAY_TO_LOWER }])
    const answer = ruled(await checkSeller(PAY_TO, read))
    expect(answer.notPaidUntil).toBeNull()
    expect(rulingLine(answer)).toContain('(Silent)')
    expect(renderToStaticMarkup(<SellerAnswerView answer={answer} />)).not.toContain('does not pay')
  })

  test('the latest of several rulings decides the dates', async () => {
    const { read } = node([
      { createdAt: CURRENT_BLOCK - 200_000, verdict: 'silent', payTo: PAY_TO_LOWER },
      { createdAt: CURRENT_BLOCK - 1_000, verdict: 'fraud', payTo: PAY_TO_LOWER },
    ])
    const answer = ruled(await checkSeller(PAY_TO, read))
    expect(answer.verdict).toBe('fraud')
    expect(answer.date).toBe(blockToDate(BigInt(CURRENT_BLOCK - 1_000), timing))
  })

  test('no ruling says so, and says Arkiv was read just now', async () => {
    const { read } = node([])
    expect(await checkSeller(PAY_TO, read)).toEqual({ kind: 'clear' })
    expect(renderToStaticMarkup(<SellerAnswerView answer={{ kind: 'clear' }} />)).toContain(CLEAR_LINE)
    expect(CLEAR_LINE).toBe('No ruling from Arc against this seller. Checked on Arkiv just now.')
  })

  test('a node that cannot be read asks to try again', async () => {
    const { read } = node('down')
    expect(await checkSeller(PAY_TO, read)).toEqual({ kind: 'unread' })
    expect(renderToStaticMarkup(<SellerAnswerView answer={{ kind: 'unread' }} />)).toContain(UNREAD_LINE)
    expect(UNREAD_LINE).toBe('Could not read Arkiv. Try again.')
  })

  test('anything but a 0x address asks for one, and Arkiv is not read', async () => {
    const { read, calls } = node([])
    for (const input of ['', 'Seller F', '0x1234', `${PAY_TO}00`]) {
      expect(await checkSeller(input, read)).toEqual({ kind: 'not-address' })
    }
    expect(calls).toEqual([])
    expect(renderToStaticMarkup(<SellerAnswerView answer={{ kind: 'not-address' }} />)).toContain("Paste a seller&#x27;s 0x address.")
    expect(NOT_ADDRESS_LINE).toBe("Paste a seller's 0x address.")
  })

  test('a pasted address with spaces and capitals is read as the lowercase column', async () => {
    const { read, calls } = node([])
    await checkSeller(`  ${PAY_TO}\n`, read)
    const query = calls.find((c) => c.includes('vet402_verdict'))!
    expect(query).toContain(`pay_to = str('${PAY_TO_LOWER}')`)
    expect(query).toContain(`seller = str('${PAY_TO_LOWER}')`)
    expect(query).toContain(' OR ')
    expect(query.toLowerCase()).toContain(`$owner = addr(${WRITER})`)
  })
})

describe('Rulings written before pay_to existed', () => {
  test('an entity with seller alone is still a ruling against that address', async () => {
    const { read } = node([{ createdAt: CURRENT_BLOCK - 10 }])
    expect(ruled(await checkSeller(PAY_TO, read)).claimUrl).toBeNull()
  })

  test('when pay_to is there it decides, so a row that names another pay_to is left out', async () => {
    const { read } = node([{ createdAt: CURRENT_BLOCK - 10, payTo: OTHER, seller: PAY_TO_LOWER }])
    expect(await checkSeller(PAY_TO, read)).toEqual({ kind: 'clear' })
  })

  test('the receipts feed reads the address from pay_to, and from seller on an old entity', async () => {
    const transport = custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'arkiv_getBlockTiming') return Promise.resolve(TIMING)
        const query = (params as [string])[0]
        const data = query.includes('vet402_verdict')
          ? [entity({ createdAt: 10, payTo: OTHER, seller: PAY_TO_LOWER }, 0), entity({ createdAt: 20 }, 1)]
          : []
        return Promise.resolve({ data, blockNumber: '0x1' })
      },
    })
    const { verdicts } = await createArkivReader(WRITER, transport)()
    expect(verdicts?.map((v) => v.seller).sort()).toEqual([OTHER, PAY_TO_LOWER].sort())
  })
})
