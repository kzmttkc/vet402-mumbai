import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { custom, toEventSelector } from 'viem'
import { createArkivReadWire, decideDelivery, NO_RECENT_PURCHASE, NOT_PAID, RULED_AGAINST } from '../arkiv'
import type { SellerRead } from '../arkiv'
import { SellerAnswerView } from '../../src/arkiv/CheckSeller'
import { createRulingsReader } from '../../src/arkiv/readArkiv'
import { arcCheckedLine, checkSeller } from '../../src/arkiv/sellerCheck'
import {
  FRAUD_TOPIC,
  isRuledAgainst,
  rulingOnArc,
  SILENT_TOPIC,
} from '../../packages/sealed-delivery/src/rulings'
import type { ArcRuling } from '../../packages/sealed-delivery/src/rulings'

// Arkiv and Arc are fakes here. Nothing leaves this machine.

const WRITER = '0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5'
const PAY_TO = '0x1401Bd7C7FAb3FE8A429672Fc1C5371456c8445d'
const OTHER = `0x${'5e'.repeat(20)}`
const CONTRACT = '0xe9c35ad2caf5d76ca5a5f61ca2256995197c2a4b'
const CLAIM_ID = `0x${'12'.repeat(32)}`
const CLAIM_TX = `0x${'3c'.repeat(32)}`
const NONCE = `0x${'77'.repeat(32)}`
const CLAIMED_TOPIC = '0x50191b91ad71dee1b0b2cfcfbfd7c2a11802f04731c87f2104e70eb6a8f3ef51'
const topicOf = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
const hex = (n: bigint | number) => `0x${n.toString(16)}`

// Arkiv: 2 seconds a block, so 302,400 blocks is 7 days.
const ARKIV_TIMING = { current_block: 1_000_000, current_block_time: 1_793_000_000, duration: 2 }
// Arc: the claim at 70,000,000, the latest block 100 later, one block a second.
const CLAIM_BLOCK = 70_000_000n
const ARC_TIME_AT_CLAIM = 1_792_990_000

interface ArcEvent {
  block: bigint
  topics: string[]
}

interface ArcNodeOptions {
  chainId?: string
  receipt?: object | null
  events?: ArcEvent[]
  latest?: bigint
  down?: boolean
}

const fraudEvent = (over: Partial<ArcEvent> = {}): ArcEvent => ({
  block: CLAIM_BLOCK + 50n,
  topics: [FRAUD_TOPIC, CLAIM_ID, NONCE, topicOf(PAY_TO)],
  ...over,
})

const claimReceipt = (over: object = {}) => ({
  status: '0x1',
  blockNumber: hex(CLAIM_BLOCK),
  logs: [{ address: CONTRACT, topics: [CLAIMED_TOPIC, CLAIM_ID, NONCE, topicOf(PAY_TO)] }],
  ...over,
})

/** An Arc node: the claim's receipt, the contract's events, and block times one second apart. */
function arcAnswer(o: ArcNodeOptions, method: string, params: unknown[]): unknown {
  const latest = o.latest ?? CLAIM_BLOCK + 100n
  if (method === 'eth_chainId') return o.chainId ?? '0x4cef52'
  if (method === 'eth_blockNumber') return hex(latest)
  if (method === 'eth_getTransactionReceipt') return o.receipt === undefined ? claimReceipt() : o.receipt
  if (method === 'eth_getBlockByNumber') return { timestamp: hex(ARC_TIME_AT_CLAIM + Number(BigInt(params[0] as string) - CLAIM_BLOCK)) }
  if (method === 'eth_getLogs') {
    const [filter] = params as [{ address: string; fromBlock: string; toBlock: string; topics: (string | null)[] }]
    if (BigInt(filter.toBlock) - BigInt(filter.fromBlock) >= 10_000n) throw new Error('requested range too large')
    return (o.events ?? [fraudEvent()])
      .filter((e) => e.block >= BigInt(filter.fromBlock) && e.block <= BigInt(filter.toBlock))
      .filter(() => filter.address === CONTRACT)
      .filter((e) => filter.topics.every((t, i) => t === null || t.toLowerCase() === e.topics[i]?.toLowerCase()))
      .map((e) => ({ address: CONTRACT, blockNumber: hex(e.block), topics: e.topics, data: '0x' }))
  }
  throw new Error(`unexpected ${method}`)
}

interface ArkivRuling {
  createdAt: number
  verdict?: string
  claimTx?: string | null
  contract?: string
  chainId?: string
  payTo?: string
}

const attr = (name: string, type: string, value: string) => ({ name, type, value })

const verdictEntity = (r: ArkivRuling, i: number) => ({
  key: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  createdAt: hex(r.createdAt),
  attributes: [
    attr('arkiv.schema', 'str', 'vet402_verdict'),
    attr('kind', 'str', 'verdict'),
    attr('claim_id', 'str', CLAIM_ID),
    attr('seller', 'str', (r.payTo ?? PAY_TO).toLowerCase()),
    attr('pay_to', 'str', (r.payTo ?? PAY_TO).toLowerCase()),
    attr('verdict', 'str', r.verdict ?? 'fraud'),
    ...(r.claimTx === null ? [] : [attr('claim_tx', 'str', r.claimTx ?? CLAIM_TX)]),
    attr('contract', 'str', r.contract ?? CONTRACT),
    attr('chain_id', 'u64', r.chainId ?? '0x4cef52'),
  ],
})

/** One fetch for both nodes, as isRuledAgainst takes one. Every method is kept, by node. */
function nodes(rulings: ArkivRuling[], arc: ArcNodeOptions = {}) {
  const calls: string[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string) as { method: string; params: unknown[] }
    const onArkiv = url.includes('arkiv')
    calls.push(`${onArkiv ? 'arkiv' : 'arc'} ${method}`)
    if (!onArkiv && arc.down) return new Response('busy', { status: 503 })
    try {
      const result = onArkiv
        ? method === 'arkiv_getBlockTiming'
          ? ARKIV_TIMING
          : { data: rulings.map(verdictEntity) }
        : arcAnswer(arc, method, params)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    } catch (error) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32012, message: (error as Error).message } }))
    }
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

const RECENT = ARKIV_TIMING.current_block - 1_000

describe('The topics are the contract’s own events', () => {
  test('Silent and Fraud match the ABI signatures', () => {
    const args = '(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)'
    expect(SILENT_TOPIC).toBe(toEventSelector(`event Silent${args}`))
    expect(FRAUD_TOPIC).toBe(toEventSelector(`event Fraud${args}`))
  })
})

describe('isRuledAgainst with verifyOnArc', () => {
  test('a ruling whose Fraud event Arc holds counts', async () => {
    const { fetch, calls } = nodes([{ createdAt: RECENT }])
    expect(await isRuledAgainst(PAY_TO, { writer: WRITER, verifyOnArc: true, fetch })).toBe(true)
    expect(calls).toContain('arc eth_getTransactionReceipt')
    expect(calls).toContain('arc eth_getLogs')
  })

  test('a Silent ruling counts by its Silent event, and not by a Fraud one', async () => {
    const silent = fraudEvent({ topics: [SILENT_TOPIC, CLAIM_ID, NONCE, topicOf(PAY_TO)] })
    expect(await isRuledAgainst(PAY_TO, { writer: WRITER, verifyOnArc: true, ...nodes([{ createdAt: RECENT, verdict: 'silent' }], { events: [silent] }) })).toBe(true)
    expect(await isRuledAgainst(PAY_TO, { writer: WRITER, verifyOnArc: true, ...nodes([{ createdAt: RECENT, verdict: 'silent' }]) })).toBe(false)
  })

  test('without verifyOnArc, Arc is never read', async () => {
    const { fetch, calls } = nodes([{ createdAt: RECENT }], { down: true })
    expect(await isRuledAgainst(PAY_TO, { writer: WRITER, fetch })).toBe(true)
    expect(calls.some((c) => c.startsWith('arc'))).toBe(false)
  })

  test('a ruling Arc does not back is not counted', async () => {
    const cases: [ArkivRuling, ArcNodeOptions][] = [
      // No event at all for the claim.
      [{ createdAt: RECENT }, { events: [] }],
      // The event is against another seller.
      [{ createdAt: RECENT }, { events: [fraudEvent({ topics: [FRAUD_TOPIC, CLAIM_ID, NONCE, topicOf(OTHER)] })] }],
      // The event is for another claim.
      [{ createdAt: RECENT }, { events: [fraudEvent({ topics: [FRAUD_TOPIC, `0x${'99'.repeat(32)}`, NONCE, topicOf(PAY_TO)] })] }],
      // The event is before the claim.
      [{ createdAt: RECENT }, { events: [fraudEvent({ block: CLAIM_BLOCK - 1n })] }],
      // The claim transaction is not on Arc, or reverted, or carries another claim.
      [{ createdAt: RECENT }, { receipt: null }],
      [{ createdAt: RECENT }, { receipt: claimReceipt({ status: '0x0' }) }],
      [{ createdAt: RECENT }, { receipt: claimReceipt({ logs: [{ address: CONTRACT, topics: [CLAIMED_TOPIC, `0x${'98'.repeat(32)}`] }] }) }],
      // The ruling names no claim transaction, a contract that is not vet402's, or another chain.
      [{ createdAt: RECENT, claimTx: null }, {}],
      [{ createdAt: RECENT, contract: OTHER }, {}],
      [{ createdAt: RECENT }, { chainId: '0x1' }],
    ]
    for (const [ruling, arc] of cases) {
      expect(await isRuledAgainst(PAY_TO, { writer: WRITER, verifyOnArc: true, ...nodes([ruling], arc) })).toBe(false)
    }
  })

  test('a ruling older than 7 days is not looked up on Arc', async () => {
    const { fetch, calls } = nodes([{ createdAt: ARKIV_TIMING.current_block - 302_400 }])
    expect(await isRuledAgainst(PAY_TO, { writer: WRITER, verifyOnArc: true, fetch })).toBe(false)
    expect(calls.some((c) => c.startsWith('arc'))).toBe(false)
  })

  test('one ruling Arc backs is enough among others it does not', async () => {
    const { fetch } = nodes([{ createdAt: RECENT, claimTx: null }, { createdAt: RECENT }])
    expect(await isRuledAgainst(PAY_TO, { writer: WRITER, verifyOnArc: true, fetch })).toBe(true)
  })

  test('an Arc node that cannot be read throws, so the buyer decides', async () => {
    const { fetch } = nodes([{ createdAt: RECENT }], { down: true })
    await expect(isRuledAgainst(PAY_TO, { writer: WRITER, verifyOnArc: true, fetch })).rejects.toThrow('Arc answered 503')
  })

  test('another Arc node and other deployments can be named', async () => {
    const urls: string[] = []
    const { fetch } = nodes([{ createdAt: RECENT, contract: OTHER }])
    const spy = ((url: string, init: RequestInit) => {
      urls.push(url)
      return fetch(url, init)
    }) as unknown as typeof globalThis.fetch
    // OTHER is accepted, but the fake contract emits nothing, so it is not counted.
    expect(await isRuledAgainst(PAY_TO, { writer: WRITER, verifyOnArc: true, arcRpcUrl: 'https://my-arc.example', contracts: [OTHER], fetch: spy })).toBe(false)
    expect(urls).toContain('https://my-arc.example')
  })
})

describe('rulingOnArc reads forward from the claim, and no later than the ruling', () => {
  const ruling = (writtenAt: number): ArcRuling => ({ claimId: CLAIM_ID, claimTx: CLAIM_TX, contract: CONTRACT, chainId: 5042002n, verdict: 'fraud', writtenAt })
  const latest = CLAIM_BLOCK + 20_000n
  const late = fraudEvent({ block: CLAIM_BLOCK + 15_000n })

  test('an event past the first 10,000 blocks is found in the next window', async () => {
    const { fetch, calls } = nodes([], { events: [late], latest })
    expect(await rulingOnArc(PAY_TO, ruling(ARC_TIME_AT_CLAIM + 20_000), { fetch })).toBe(true)
    expect(calls.filter((c) => c === 'arc eth_getLogs')).toHaveLength(2)
  })

  test('an event the writer could not have seen when it wrote the ruling is not found', async () => {
    const { fetch, calls } = nodes([], { events: [late], latest })
    expect(await rulingOnArc(PAY_TO, ruling(ARC_TIME_AT_CLAIM + 5_000), { fetch })).toBe(false)
    expect(calls.filter((c) => c === 'arc eth_getLogs')).toHaveLength(1)
  })
})

describe('Check a seller shows the line from Arc only when it checked', () => {
  const arkiv = (rulings: ArkivRuling[]) =>
    custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        const entities = rulings.map(verdictEntity)
        if (method === 'arkiv_getBlockTiming') return Promise.resolve(ARKIV_TIMING)
        if (method === 'arkiv_getEntity') return Promise.resolve(entities.find((e) => e.key === (params as [string])[0]) ?? null)
        return Promise.resolve({ data: entities, blockNumber: hex(ARKIV_TIMING.current_block) })
      },
    })

  test('a ruling Arc backs gets "Checked on Arc"', async () => {
    const { fetch } = nodes([])
    const answer = await checkSeller(PAY_TO, createRulingsReader(WRITER, arkiv([{ createdAt: RECENT }]), { fetch }))
    if (answer.kind !== 'ruled') throw new Error(answer.kind)
    expect(answer.checkedOnArc).toBe(true)
    const html = renderToStaticMarkup(<SellerAnswerView answer={answer} />)
    expect(html).toContain('Checked on Arc: the Fraud event for this claim is on chain.')
    expect(arcCheckedLine('silent')).toBe('Checked on Arc: the Silent event for this claim is on chain.')
  })

  test('a ruling Arc does not back, or an Arc read that fails, still shows the ruling without the line', async () => {
    for (const arc of [nodes([], { events: [] }), nodes([], { down: true })]) {
      const answer = await checkSeller(PAY_TO, createRulingsReader(WRITER, arkiv([{ createdAt: RECENT }]), { fetch: arc.fetch }))
      if (answer.kind !== 'ruled') throw new Error(answer.kind)
      expect(answer.checkedOnArc).toBeUndefined()
      expect(renderToStaticMarkup(<SellerAnswerView answer={answer} />)).not.toContain('Checked on Arc')
    }
  })

  test('with Arc turned off, the ruling shows without the line', async () => {
    const answer = await checkSeller(PAY_TO, createRulingsReader(WRITER, arkiv([{ createdAt: RECENT }]), null))
    if (answer.kind !== 'ruled') throw new Error(answer.kind)
    expect(answer.checkedOnArc).toBeUndefined()
  })
})

const read = (over: Partial<SellerRead> = {}): SellerRead => ({
  sellerLive: false,
  paymentBlocks: [],
  verdictBlocks: [],
  currentBlock: 1_000_000n,
  blockSeconds: 2,
  ...over,
})
const SEVEN_DAYS = 302_400n

describe('A seller nobody bought from for a while is not stopped', () => {
  test('the latest payment came back and is 7 days old or more: it goes on with a plain line', () => {
    expect(decideDelivery(read({ paymentBlocks: [1_000_000n - SEVEN_DAYS] }))).toEqual({ kind: 'busy', line: NO_RECENT_PURCHASE })
    expect(decideDelivery(read({ paymentBlocks: [5n, 900n] }))).toEqual({ kind: 'busy', line: NO_RECENT_PURCHASE })
    expect(NO_RECENT_PURCHASE).toBe('No recent purchase from this seller.')
  })

  test('the latest payment is under 7 days old and the entity is gone: it did not extend it, so it stops', () => {
    expect(decideDelivery(read({ paymentBlocks: [1_000_000n - SEVEN_DAYS + 1n] }))).toEqual({ kind: 'expired', line: NOT_PAID })
    // The Seller C scene: a short lifetime, bought from hours ago.
    expect(decideDelivery(read({ paymentBlocks: [1_000_000n - 21_000n] })).kind).toBe('expired')
  })

  test('the latest payment never came back: it stops, however old', () => {
    expect(decideDelivery(read({ paymentBlocks: [5n, 900n], undeliveredBlocks: [900n] }))).toEqual({ kind: 'expired', line: NOT_PAID })
    // An older failure does not stop a seller whose latest payment came back.
    expect(decideDelivery(read({ paymentBlocks: [5n, 900n], undeliveredBlocks: [5n] })).kind).toBe('busy')
  })

  test('the rows before it still decide first', () => {
    expect(decideDelivery(read({ paymentBlocks: [5n], verdictBlocks: [999_000n] }))).toEqual({ kind: 'expired', line: RULED_AGAINST })
    expect(decideDelivery(read({ sellerLive: true, paymentBlocks: [5n], undeliveredBlocks: [5n] })).kind).toBe('live')
    expect(decideDelivery(read()).kind).toBe('first')
    // A payment under a minute old is still not counted, so the older one decides.
    expect(decideDelivery(read({ paymentBlocks: [5n, 999_999n], undeliveredBlocks: [999_999n] })).kind).toBe('busy')
  })

  test('the real client reads which payments never came back from times_received', async () => {
    const payment = (n: number, createdAt: number, times: string) => ({
      key: `0x${n.toString(16).padStart(64, '0')}`,
      createdAt: hex(createdAt),
      expiresAt: hex(2_000_000),
      attributes: [
        attr('arkiv.schema', 'str', 'vet402_receipt'),
        attr('kind', 'str', 'payment'),
        attr('seller', 'str', 'Quiet'),
        attr('times_received', 'u64', times),
      ],
    })
    const queries: string[] = []
    const transport = custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'arkiv_getBlockTiming') return Promise.resolve(ARKIV_TIMING)
        const query = (params as [string])[0]
        queries.push(query)
        const data = query.includes("kind = str('payment')") ? [payment(1, 10, '0x1'), payment(2, 20, '0x0')] : []
        return Promise.resolve({ data, blockNumber: hex(ARKIV_TIMING.current_block) })
      },
    })
    const got = await createArkivReadWire({ writer: WRITER, transport }).readSeller({ name: 'Quiet', payTo: null })
    expect(got.paymentBlocks).toEqual([10n, 20n])
    expect(got.undeliveredBlocks).toEqual([20n])
    expect(decideDelivery(got)).toEqual({ kind: 'expired', line: NOT_PAID })
  })
})
