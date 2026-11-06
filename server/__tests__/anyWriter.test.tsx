import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { custom } from 'viem'
import { SellerAnswerView } from '../../src/arkiv/CheckSeller'
import { createRulingsReader } from '../../src/arkiv/readArkiv'
import { blockToDate } from '../../src/arkiv/receiptsFeed'
import { checkSeller, RULING_SECONDS, writtenByLine } from '../../src/arkiv/sellerCheck'
import type { SellerAnswer } from '../../src/arkiv/sellerCheck'
import { FRAUD_TOPIC, isRuledAgainst, rulingQuery } from '../../packages/sealed-delivery/src/rulings'

// Rulings from more than one writer, each counted only once Arc confirms it. Arkiv and Arc are fakes here.

const VET402 = '0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5'
const SECOND = `0x${'2b'.repeat(20)}`
const THIRD = `0x${'3c'.repeat(20)}`
const PAY_TO = '0x1401Bd7C7FAb3FE8A429672Fc1C5371456c8445d'
const OTHER = `0x${'5e'.repeat(20)}`
const CONTRACT = '0xe9c35ad2caf5d76ca5a5f61ca2256995197c2a4b'
const CLAIMED_TOPIC = '0x50191b91ad71dee1b0b2cfcfbfd7c2a11802f04731c87f2104e70eb6a8f3ef51'
const NONCE = `0x${'77'.repeat(32)}`
const topicOf = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
const hex = (n: bigint | number) => `0x${n.toString(16)}`
const claimOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const txOf = (n: number) => `0x${(n + 0x1000).toString(16).padStart(64, '0')}`

// Arkiv: 2 seconds a block, so 302,400 blocks is 7 days.
const TIMING = { current_block: 1_000_000, current_block_time: 1_793_000_000, duration: 2 }
const timing = { currentBlock: BigInt(TIMING.current_block), currentBlockTime: TIMING.current_block_time, blockDuration: 2 }
// Arc: every claim at block 70,000,000 and its ruling 50 blocks later, one block a second, well before Arkiv's rows.
const CLAIM_BLOCK = 70_000_000n
const ARC_TIME_AT_CLAIM = 1_792_000_000

interface Row {
  writer: string
  createdAt: number
  /** The claim this row names. Arc holds a Fraud event only for the claims in `onArc`. */
  claim: number
  payTo?: string
  seller?: string
}

const attr = (name: string, type: string, value: string) => ({ name, type, value })

const entity = (r: Row, i: number) => ({
  key: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  createdAt: hex(r.createdAt),
  creator: r.writer,
  owner: r.writer,
  attributes: [
    attr('arkiv.schema', 'str', 'vet402_verdict'),
    attr('kind', 'str', 'verdict'),
    attr('claim_id', 'str', claimOf(r.claim)),
    attr('seller', 'str', (r.seller ?? r.payTo ?? PAY_TO).toLowerCase()),
    attr('pay_to', 'str', (r.payTo ?? PAY_TO).toLowerCase()),
    attr('verdict', 'str', 'fraud'),
    attr('claim_tx', 'str', txOf(r.claim)),
    attr('contract', 'str', CONTRACT),
    attr('chain_id', 'u64', '0x4cef52'),
  ],
})

/** An Arc node that holds a claim for every claim number, and a Fraud event only for those in `onArc`. */
function arcAnswer(onArc: number[], method: string, params: unknown[]): unknown {
  if (method === 'eth_chainId') return '0x4cef52'
  if (method === 'eth_blockNumber') return hex(CLAIM_BLOCK + 100n)
  if (method === 'eth_getTransactionReceipt') {
    const claim = Number(BigInt(params[0] as string) - 0x1000n)
    return { status: '0x1', blockNumber: hex(CLAIM_BLOCK), logs: [{ address: CONTRACT, topics: [CLAIMED_TOPIC, claimOf(claim), NONCE, topicOf(PAY_TO)] }] }
  }
  if (method === 'eth_getBlockByNumber') return { timestamp: hex(ARC_TIME_AT_CLAIM + Number(BigInt(params[0] as string) - CLAIM_BLOCK)) }
  if (method === 'eth_getLogs') {
    const [filter] = params as [{ topics: (string | null)[] }]
    const claim = Number(BigInt(filter.topics[1] as string))
    if (!onArc.includes(claim) || filter.topics[3] !== topicOf(PAY_TO)) return []
    return [{ address: CONTRACT, blockNumber: hex(CLAIM_BLOCK + 50n), topics: [FRAUD_TOPIC, claimOf(claim), NONCE, topicOf(PAY_TO)], data: '0x' }]
  }
  throw new Error(`unexpected ${method}`)
}

/** One fetch for both nodes, as isRuledAgainst takes. Each Arkiv query string is kept. */
function nodes(rows: Row[], onArc: number[], arcDown = false) {
  const queries: string[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string) as { method: string; params: unknown[] }
    const onArkiv = url.includes('arkiv')
    if (onArkiv && method === 'arkiv_query') queries.push(params[0] as string)
    if (!onArkiv && arcDown) return new Response('busy', { status: 503 })
    const result = onArkiv ? (method === 'arkiv_getBlockTiming' ? TIMING : { data: rows.map(entity) }) : arcAnswer(onArc, method, params)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, queries }
}

/** The receipts page's reader over every writer: Arkiv through a transport, Arc through fetch. */
function pageReader(rows: Row[], onArc: number[], arcDown = false) {
  const queries: string[] = []
  const transport = custom({
    request: ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'arkiv_getBlockTiming') return Promise.resolve(TIMING)
      if (method === 'arkiv_query') {
        queries.push((params as [string])[0])
        return Promise.resolve({ data: rows.map(entity), blockNumber: hex(TIMING.current_block) })
      }
      return Promise.reject(new Error(`unexpected ${method}`))
    },
  })
  const read = createRulingsReader(VET402, transport, { fetch: nodes([], onArc, arcDown).fetch }, 'any')
  return { read, queries }
}

const RECENT = TIMING.current_block - 1_000

const ruled = (answer: SellerAnswer) => {
  if (answer.kind !== 'ruled') throw new Error(`expected a ruling, got ${answer.kind}`)
  return answer
}

describe("isRuledAgainst with writers: 'any'", () => {
  test('a ruling Arc confirms counts, whoever wrote it, and the query has no writer filter', async () => {
    const { fetch, queries } = nodes([{ writer: SECOND, createdAt: RECENT, claim: 1 }], [1])
    expect(await isRuledAgainst(PAY_TO, { writers: 'any', verifyOnArc: true, fetch })).toBe(true)
    expect(queries[0]).toBe(rulingQuery(PAY_TO, 'any'))
    expect(queries[0]).not.toContain('$owner')
    expect(queries[0]).toContain(`(pay_to = str('${PAY_TO.toLowerCase()}') OR seller = str('${PAY_TO.toLowerCase()}'))`)
  })

  test('a ruling Arc does not confirm counts for nothing', async () => {
    const { fetch } = nodes([{ writer: SECOND, createdAt: RECENT, claim: 1 }], [])
    expect(await isRuledAgainst(PAY_TO, { writers: 'any', verifyOnArc: true, fetch })).toBe(false)
  })

  test("another writer's unconfirmed ruling is passed over, and a confirmed one from a third writer still counts", async () => {
    const rows = [
      { writer: SECOND, createdAt: RECENT, claim: 1 },
      { writer: THIRD, createdAt: RECENT - 10, claim: 2 },
    ]
    expect(await isRuledAgainst(PAY_TO, { writers: 'any', verifyOnArc: true, fetch: nodes(rows, [2]).fetch })).toBe(true)
    expect(await isRuledAgainst(PAY_TO, { writers: 'any', verifyOnArc: true, fetch: nodes(rows, []).fetch })).toBe(false)
  })

  test('a confirmed ruling older than 7 days does not count', async () => {
    const { fetch } = nodes([{ writer: SECOND, createdAt: TIMING.current_block - RULING_SECONDS / 2, claim: 1 }], [1])
    expect(await isRuledAgainst(PAY_TO, { writers: 'any', verifyOnArc: true, fetch })).toBe(false)
  })

  test('without verifyOnArc it throws before reading anything, and writer cannot be spelled any', async () => {
    const { fetch, queries } = nodes([{ writer: SECOND, createdAt: RECENT, claim: 1 }], [1])
    await expect(isRuledAgainst(PAY_TO, { writers: 'any', fetch })).rejects.toThrow('verifyOnArc')
    await expect(isRuledAgainst(PAY_TO, { writers: 'any', verifyOnArc: false, fetch })).rejects.toThrow('verifyOnArc')
    await expect(isRuledAgainst(PAY_TO, { writer: 'any', fetch })).rejects.toThrow('0x addresses')
    expect(queries).toEqual([])
  })
})

describe('isRuledAgainst with { writer } answers as before', () => {
  test('the same rulings give the same answers, filtered on the writer', async () => {
    const recent = [{ writer: VET402, createdAt: RECENT, claim: 1 }]
    const old = [{ writer: VET402, createdAt: TIMING.current_block - RULING_SECONDS / 2, claim: 1 }]
    const { fetch, queries } = nodes(recent, [])
    expect(await isRuledAgainst(PAY_TO, { writer: VET402, fetch })).toBe(true)
    expect(await isRuledAgainst(PAY_TO, { writer: VET402, fetch: nodes(old, []).fetch })).toBe(false)
    expect(await isRuledAgainst(PAY_TO, { writer: VET402, fetch: nodes([], []).fetch })).toBe(false)
    expect(await isRuledAgainst(PAY_TO, { writer: VET402, verifyOnArc: true, fetch: nodes(recent, [1]).fetch })).toBe(true)
    expect(await isRuledAgainst(PAY_TO, { writer: VET402, verifyOnArc: true, fetch: nodes(recent, []).fetch })).toBe(false)
    expect(queries[0]).toBe(rulingQuery(PAY_TO, VET402))
    expect(queries[0]).toContain(`$owner = addr(${VET402})`)
    expect(queries[0]).toContain(`seller = str('${PAY_TO.toLowerCase()}')`)
  })

  test('an entity with seller alone still counts, and one whose pay_to names another address does not', async () => {
    const sellerOnly = { ...entity({ writer: VET402, createdAt: RECENT, claim: 1 }, 0) }
    sellerOnly.attributes = sellerOnly.attributes.filter((a) => a.name !== 'pay_to')
    const only = (async (url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string }
      return new Response(JSON.stringify({ result: method === 'arkiv_getBlockTiming' ? TIMING : { data: [sellerOnly] } }))
    }) as unknown as typeof fetch
    expect(await isRuledAgainst(PAY_TO, { writer: VET402, fetch: only })).toBe(true)
    const elsewhere = nodes([{ writer: VET402, createdAt: RECENT, claim: 1, payTo: OTHER, seller: PAY_TO }], [])
    expect(await isRuledAgainst(PAY_TO, { writer: VET402, fetch: elsewhere.fetch })).toBe(false)
  })
})

describe('Check a seller reads every writer', () => {
  test("another writer's confirmed copy is named by its short address, and vet402's own ruling sets the date it pays again", async () => {
    const own = RECENT - 5_000
    const { read, queries } = pageReader(
      [
        { writer: VET402.toLowerCase(), createdAt: own, claim: 1 },
        { writer: SECOND, createdAt: RECENT, claim: 1 },
      ],
      [1],
    )
    const answer = ruled(await checkSeller(PAY_TO, read))
    expect(answer.writtenBy).toBe(SECOND)
    expect(answer.date).toBe(blockToDate(BigInt(RECENT), timing))
    expect(answer.notPaidUntil).toBe(blockToDate(BigInt(own + RULING_SECONDS / 2), timing))
    const html = renderToStaticMarkup(<SellerAnswerView answer={answer} />)
    expect(html).toContain('Written to Arkiv by 0x2b2b…2b2b, checked on Arc.')
    expect(queries[0]).not.toContain('$owner')
    expect(queries[0]).toContain(' OR ')
  })

  test('vet402 as the writer is named vet402', async () => {
    const { read } = pageReader([{ writer: VET402, createdAt: RECENT, claim: 1 }], [1])
    const answer = ruled(await checkSeller(PAY_TO, read))
    expect(answer.writtenBy).toBe('vet402')
    expect(writtenByLine(answer.writtenBy!)).toBe('Written to Arkiv by vet402, checked on Arc.')
    expect(answer.notPaidUntil).toBe(blockToDate(BigInt(RECENT + RULING_SECONDS / 2), timing))
  })

  test('only another writer confirmed: the ruling shows, and no date for vet402 is claimed', async () => {
    const { read } = pageReader([{ writer: THIRD, createdAt: RECENT, claim: 1 }], [1])
    const answer = ruled(await checkSeller(PAY_TO, read))
    expect(answer.writtenBy).toBe(THIRD)
    expect(answer.notPaidUntil).toBeNull()
    expect(renderToStaticMarkup(<SellerAnswerView answer={answer} />)).not.toContain('does not pay')
  })

  test('a ruling Arc does not confirm is not shown, whoever wrote it', async () => {
    const { read } = pageReader(
      [
        { writer: SECOND, createdAt: RECENT, claim: 1 },
        { writer: VET402, createdAt: RECENT - 10, claim: 2 },
      ],
      [],
    )
    expect(await checkSeller(PAY_TO, read)).toEqual({ kind: 'clear' })
  })

  test('an unconfirmed newer ruling gives way to an older confirmed one', async () => {
    const { read } = pageReader(
      [
        { writer: SECOND, createdAt: RECENT, claim: 1 },
        { writer: THIRD, createdAt: RECENT - 10, claim: 2 },
      ],
      [2],
    )
    const answer = ruled(await checkSeller(PAY_TO, read))
    expect(answer.writtenBy).toBe(THIRD)
    expect(answer.claimId).toBe(claimOf(2))
  })

  test('Arc down with nothing confirmed reads as unread, never as clear', async () => {
    const { read } = pageReader([{ writer: SECOND, createdAt: RECENT, claim: 1 }], [1], true)
    expect(await checkSeller(PAY_TO, read)).toEqual({ kind: 'unread' })
  })

  test("'any' without the Arc check is refused", () => {
    expect(() => createRulingsReader(VET402, custom({ request: () => Promise.resolve(null) }), null, 'any')).toThrow('Arc')
  })
})
