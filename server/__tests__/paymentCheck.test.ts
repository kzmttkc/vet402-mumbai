import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  numberToHex,
  parseTransaction,
  stringToBytes,
  toFunctionSelector,
} from 'viem'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { BALANCE_CHECK_NAME, createBalanceCheck } from '../balanceCheckSeller'
import { toCandidate } from '../discovery'
import type { Candidate } from '../discovery'
import {
  CLAIM_OPEN,
  createPaymentCheck,
  DELIVERED_SEALED,
  describeLastPayment,
  PAYMENT_CHECK_NAME,
  PAYMENT_CHECK_RESOURCE,
  paymentCheckCandidate,
} from '../paymentCheckSeller'
import type { OwnPurchase } from '../paymentCheckSeller'
import type { PlannedRequest } from '../planner'
import { CLAIMED_EVENTS, createSealedDelivery, createSealedPorts, SEALED_ABI } from '../sealedDelivery'
import type { SealedBox, SealedPorts } from '../sealedDelivery'
import { DEMO_PRICE } from '../sellers'
import type { SellerFacilitator } from '../sellers'
import { createTryJob, PROTECTED_LINE } from '../tryJob'
import type { PaidReply, TryJobPorts, TryPlanView } from '../tryJob'

// vet402 Payment Check: vet402's own sealed seller beside Circle's Arc catalog. The catalog is the file read on
// 2026-11-06, the chain is a fake JSON-RPC node on a local port, and Gateway is a fake facilitator, so nothing
// here reaches a real network.

const NETWORK = 'eip155:5042002'
const TX = `0x${'ab'.repeat(32)}`
const TRANSFER_ID = '0b7c4f3e-1a2b-4c3d-8e9f-0123456789ab'
const SEALED: Address = '0x00000000000000000000000000000000000000c1'
const PAYMENT_JOB = 'Did my last payment go through?'

const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures/arc-discovery-2026-11-06.json'), 'utf8')) as {
  items: Parameters<typeof toCandidate>[0][]
}
const catalog: Candidate[] = raw.items.flatMap((item) => {
  const c = toCandidate(item, NETWORK)
  return c ? [c] : []
})

const holdKey = generatePrivateKey()
const sellerKey = generatePrivateKey()
const buyerKey = generatePrivateKey()
const HOLD = privateKeyToAccount(holdKey).address
const SELLER = privateKeyToAccount(sellerKey).address

describe('vet402 Payment Check, the listing', () => {
  test('reads like a catalog listing that seals under SealedDelivery, and is marked as vet402 own', () => {
    const own = paymentCheckCandidate(SELLER, SEALED)
    expect(own.sellerName).toBe(PAYMENT_CHECK_NAME)
    expect(own.sealedBy).toBe(SEALED)
    expect(own.payTo).toBe(SELLER)
    expect(own.amount).toBe(DEMO_PRICE)
    expect(own.method).toBe('GET')
    expect(own.own).toBe(true)
    expect(own.resource).toBe(PAYMENT_CHECK_RESOURCE)
    // A Discovery listing never carries the mark.
    expect(catalog.some((c) => c.own)).toBe(false)
  })

  test('the answer says plainly where the last payment stands on Circle’s record', () => {
    const to = '0xf46394addda95a3d5bcc1124605e3d15d204623c'
    expect(describeLastPayment([])).toBe("Circle's record shows no payments from your agent yet.")
    // The check's own payment is left out, so the answer is about the payment before it.
    const self = '0x00000000000000000000000000000000000000c4'
    expect(
      describeLastPayment(
        [
          { status: 'received', amount: '1000', toAddress: self.toUpperCase().replace('0X', '0x'), createdAt: '2026-11-06T03:00:00Z' },
          { status: 'completed', amount: '100', toAddress: '0x00000000000000000000000000000000000000d5', createdAt: '2026-11-06T02:00:00Z' },
        ],
        self,
      ),
    ).toBe("Yes, your agent's last payment went through. It paid 0.0001 USDC to 0x0000…00d5, and Arc has settled it.")
    expect(
      describeLastPayment([
        { status: 'received', amount: '1000', toAddress: to, createdAt: '2026-11-06T01:00:00Z' },
        { status: 'completed', amount: '100', toAddress: to, createdAt: '2026-11-06T02:00:00Z' },
      ]),
    ).toBe("Yes, your agent's last payment went through. It paid 0.0001 USDC to 0xf463…623c, and Arc has settled it.")
    expect(describeLastPayment([{ status: 'batched', amount: '100', toAddress: to, createdAt: '2026-11-06T02:00:00Z' }])).toBe(
      "Yes, your agent's last payment went through. It paid 0.0001 USDC to 0xf463…623c, and Circle is settling it on Arc.",
    )
    expect(describeLastPayment([{ status: 'failed', amount: '100', toAddress: to, createdAt: '2026-11-06T02:00:00Z' }])).toBe(
      "No, your agent's last payment of 0.0001 USDC to 0xf463…623c did not go through.",
    )
  })
})

interface Setup {
  /** What the deposit contract says for a sealing seller. Absent leaves the agent without a coverage read. */
  covers?: boolean | null
  listings?: Candidate[]
}

function setup(over: Setup = {}) {
  const candidate = paymentCheckCandidate(SELLER, SEALED)
  const paid: { request: PlannedRequest; cap: bigint }[] = []
  const bought: bigint[] = []
  const read: Candidate[][] = []
  const listings = over.listings ?? catalog
  const purchase: OwnPurchase = {
    data: "Yes, your agent's last payment went through.",
    paid: DEMO_PRICE,
    nonce: `0x${'ee'.repeat(32)}`,
    timesReceived: 1,
    transaction: TRANSFER_ID,
    lines: [
      'Answer received and checked. You paid 0.001 USDC once.',
      `Detail: ${DELIVERED_SEALED}`,
      'Detail: The key and the answer match the hashes the seller signed for this payment.',
    ],
  }
  const ports: TryJobPorts = {
    candidates: () => {
      read.push(listings)
      return Promise.resolve(listings)
    },
    latestReceipt: () => Promise.resolve({ batchTx: TX }),
    holdAvailable: () => Promise.resolve(1_000_000n),
    pay: (request, cap) => {
      paid.push({ request, cap })
      return Promise.resolve({ data: { result: { status: '0x1' } }, paid: cap, nonce: `0x${'ff'.repeat(32)}`, timesReceived: 1, transaction: '' })
    },
    findTransfer: () => Promise.resolve({ id: TRANSFER_ID, status: 'received', txHash: null }),
    ownTransfer: () => Promise.resolve(null),
    recentPayments: () => Promise.resolve([]),
    ownSellers: [
      {
        candidate,
        buy: (cap) => {
          bought.push(cap)
          return Promise.resolve(purchase)
        },
      },
    ],
    ...(over.covers === undefined
      ? {}
      : { coverage: (c: Candidate) => Promise.resolve(c.sealedBy ? (over.covers as boolean | null) : null) }),
    log: () => {},
  }
  const service = createTryJob(ports, { secret: 'test secret', now: () => 1_800_000_000_000 })
  return { service, paid, bought, read }
}

async function planOf(service: ReturnType<typeof createTryJob>, job = PAYMENT_JOB): Promise<TryPlanView> {
  const reply = await service.plan(job, '203.0.113.7')
  if (!reply.ok || !reply.value.ok) throw new Error('expected a plan')
  return reply.value.plan
}

describe('the agent ranks vet402 Payment Check beside the Arc catalog', () => {
  test('all 134 Discovery listings are read, and the protected seller is a candidate beside them', async () => {
    const { service, read } = setup({ covers: true })
    const plan = await planOf(service)
    expect(read).toHaveLength(1)
    expect(read[0]).toHaveLength(134)
    expect(plan.why).toContain("Picked from 134 Arc listings and vet402's own seller")
    const own = plan.compared.find((c) => c.sellerName === PAYMENT_CHECK_NAME)
    expect(own).toEqual({ sellerName: PAYMENT_CHECK_NAME, listing: 'payment-check', amount: '0.001', note: 'Picked', own: true })
    expect(plan.compared.filter((c) => c.sellerName === 'Quicknode')).toHaveLength(1)
  })

  test('"Did my last payment go through?" ranks it above the Quicknode node on plain word statistics', async () => {
    const { service } = setup()
    const plan = await planOf(service)
    expect(plan.sellerName).toBe(PAYMENT_CHECK_NAME)
    expect(plan.own).toBe(true)
    expect(plan.compared.map((c) => `${c.sellerName} ${c.note}`)).toEqual([
      `${PAYMENT_CHECK_NAME} Picked`,
      'Quicknode Lower match',
      'BotPay Only a payment word matched',
    ])
  })

  test('a catalog listing under its name is left out, so nothing can pass as vet402 own', async () => {
    const fake = { ...catalog[0]!, sellerName: PAYMENT_CHECK_NAME, matchText: 'vet402 payment check last payment went through' }
    const { service } = setup({ listings: [...catalog, fake] })
    const plan = await planOf(service)
    expect(plan.compared.filter((c) => c.sellerName === PAYMENT_CHECK_NAME)).toEqual([
      { sellerName: PAYMENT_CHECK_NAME, listing: 'payment-check', amount: '0.001', note: 'Picked', own: true },
    ])
  })

  test('a job about something else still picks from the catalog', async () => {
    const { service } = setup({ covers: true })
    const plan = await planOf(service, 'Get me a paid access receipt')
    expect(plan.sellerName).toBe('BotPay')
    expect(plan.own).toBeUndefined()
    expect(plan.protection).toBeUndefined()
  })
})

describe('the protection line on the approval card', () => {
  test('is there when the pick seals and coverageFor is true', async () => {
    const { service } = setup({ covers: true })
    const plan = await planOf(service)
    expect(plan.protection).toBe(PROTECTED_LINE)
    expect(plan.why).toContain('its deposit covers it')
  })

  test('is not there when coverageFor is false, and the agent does not pick that seller', async () => {
    const { service } = setup({ covers: false })
    const plan = await planOf(service)
    expect(plan.protection).toBeUndefined()
    expect(plan.sellerName).toBe('Quicknode')
    expect(plan.compared.find((c) => c.sellerName === PAYMENT_CHECK_NAME)?.note).toBe('Deposit doesn’t cover it')
  })

  test('is not there when the contract could not be read, or when there is no coverage read at all', async () => {
    for (const covers of [null, undefined]) {
      const { service } = setup({ covers })
      const plan = await planOf(service)
      expect(plan.sellerName).toBe(PAYMENT_CHECK_NAME)
      expect(plan.protection).toBeUndefined()
    }
  })
})

describe('approving vet402 Payment Check', () => {
  test('buys it from vet402 itself, never through the catalog route, and the receipt carries the sealed lines', async () => {
    const { service, paid, bought } = setup({ covers: true })
    const plan = await planOf(service)
    const reply = await service.approve(PAYMENT_JOB, plan.id, '203.0.113.7')
    if (!reply.ok) throw new Error(`expected a payment, got ${reply.code}`)
    const value: PaidReply = reply.value
    expect(paid).toHaveLength(0)
    expect(bought).toEqual([DEMO_PRICE])
    expect(value.sellerName).toBe(PAYMENT_CHECK_NAME)
    expect(value.text).toBe("Yes, your agent's last payment went through.")
    expect(value.paid).toBe('0.001')
    expect(value.lines).toEqual([
      'Answer received and checked. You paid 0.001 USDC once.',
      `Detail: ${DELIVERED_SEALED}`,
      'Detail: The key and the answer match the hashes the seller signed for this payment.',
    ])
  })
})

// A JSON-RPC node that answers what viem asks, keeps every signed transaction, and has no key on it.
interface FakeNode {
  url: string
  sent: { to: Address; data: Hex }[]
}

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
})

const COVERAGE_FOR = toFunctionSelector('coverageFor(address,uint256)')
const CLAIM_ID: Hex = `0x${'c1'.repeat(32)}`

async function fakeNode(): Promise<FakeNode> {
  const node: FakeNode = { url: '', sent: [] }
  const receipts = new Map<string, Address>()
  const claimedLog = (hash: unknown) => ({
    address: SEALED,
    topics: encodeEventTopics({ abi: [CLAIMED_EVENTS[1]], eventName: 'Claimed', args: { claimId: CLAIM_ID, paymentNonce: `0x${'d'.repeat(64)}`, seller: SELLER } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }], [HOLD, 2000n, 4000n]),
    blockNumber: '0x2',
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: `0x${'b'.repeat(64)}`,
    logIndex: '0x0',
    removed: false,
  })
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return numberToHex(arcTestnet.id)
      case 'eth_getCode':
        return '0x'
      case 'eth_getTransactionCount':
        return numberToHex(node.sent.length)
      case 'eth_gasPrice':
        return '0x4a817c800'
      case 'eth_maxPriorityFeePerGas':
        return '0x0'
      case 'eth_blockNumber':
        return '0x2'
      case 'eth_getBlockByNumber':
        return {
          number: '0x2',
          hash: `0x${'b'.repeat(64)}`,
          parentHash: `0x${'a'.repeat(64)}`,
          timestamp: '0x1',
          baseFeePerGas: '0x4a817c800',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          transactions: [],
        }
      case 'eth_estimateGas':
        return '0x30000'
      case 'eth_call': {
        // The deposit covers the price, and every wallet has plenty of gas money.
        const data = String((params[0] as { data?: string }).data ?? '')
        return encodeAbiParameters([{ type: 'uint256' }], [data.startsWith(COVERAGE_FOR) ? 1n : 10n ** 18n])
      }
      case 'eth_getLogs':
        return []
      case 'eth_sendRawTransaction': {
        const tx = parseTransaction(params[0] as Hex)
        node.sent.push({ to: tx.to as Address, data: tx.data as Hex })
        const hash = keccak256(params[0] as Hex)
        receipts.set(hash, tx.to as Address)
        return hash
      }
      case 'eth_getTransactionReceipt': {
        const to = receipts.get(String(params[0]))
        if (!to) return null
        return {
          transactionHash: params[0],
          transactionIndex: '0x0',
          blockHash: `0x${'b'.repeat(64)}`,
          blockNumber: '0x2',
          from: HOLD,
          to,
          cumulativeGasUsed: '0x30000',
          gasUsed: '0x30000',
          effectiveGasPrice: '0x4a817c800',
          contractAddress: null,
          logs: to.toLowerCase() === SEALED.toLowerCase() ? [claimedLog(params[0])] : [],
          logsBloom: `0x${'0'.repeat(512)}`,
          status: '0x1',
          type: '0x2',
        }
      }
      default:
        throw new Error(`fake node: ${method} is not answered`)
    }
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      type Call = { id: number; method: string; params: unknown[] }
      const calls = JSON.parse(body) as Call | Call[]
      const one = (call: Call) => {
        try {
          return { jsonrpc: '2.0', id: call.id, result: answer(call.method, call.params ?? []) }
        } catch (error) {
          const message = (error as Error).message
          return { jsonrpc: '2.0', id: call.id, error: { code: message.includes('is not answered') ? -32601 : 3, message } }
        }
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(Array.isArray(calls) ? calls.map(one) : one(calls)))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  node.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return node
}

const facilitator: SellerFacilitator = {
  verify: () => Promise.resolve({ isValid: true }),
  settle: () => Promise.resolve({ success: true, transaction: TRANSFER_ID }),
}

const BALANCE_ANSWER = 'Your agent has 0.9839 USDC left to spend after this check, in its Circle Gateway balance on Arc.'

async function seller(handsOverKey: boolean, kind: 'payment' | 'balance' = 'payment') {
  const node = await fakeNode()
  const client = createSealedDelivery({ address: SEALED, net: { chain: arcTestnet, rpcUrl: node.url, pollingMs: 5 } })
  const real = createSealedPorts({ client, holdKey, buyerKey, rejected: new Set() })
  const boxes: SealedBox[] = []
  const claims: SealedBox[] = []
  const sealed: SealedPorts = {
    ...real,
    async readBox(body, payment) {
      const read = await real.readBox(body, payment)
      if (read.kind === 'box') boxes.push(read.box)
      return read
    },
    async claim(box, payment) {
      claims.push(box)
      return real.claim(box, payment)
    },
  }
  const payers: string[] = []
  const prices: bigint[] = []
  const options = {
    client,
    sealed,
    sealedAddress: SEALED,
    keys: { hold: holdKey, seller: sellerKey, buyer: buyerKey },
    facilitator,
    holdAvailable: () => Promise.resolve(1_000_000n),
    handsOverKey: () => handsOverKey,
    watchMs: 20,
    pollMs: 20,
    keyWaitMs: 300,
    log: () => {},
  }
  const check =
    kind === 'payment'
      ? createPaymentCheck({
          ...options,
          lastPayment: (payer) => {
            payers.push(payer)
            return Promise.resolve("Yes, your agent's last payment went through. It paid 0.0001 USDC to 0xf463…623c, and Arc has settled it.")
          },
        })
      : createBalanceCheck({
          ...options,
          balance: (payer, thisCheck) => {
            payers.push(payer)
            prices.push(thisCheck)
            return Promise.resolve(BALANCE_ANSWER)
          },
        })
  return { node, check, boxes, claims, payers, prices }
}

describe('vet402 Payment Check, bought for real against a fake chain', () => {
  test('the key comes over the connection: the box opens, its hash matches the promise, and nothing touches the chain', async () => {
    const { node, check, boxes, claims, payers } = await seller(true)
    const result = await check.buy(DEMO_PRICE)

    expect(payers.map((p) => p.toLowerCase())).toEqual([HOLD.toLowerCase()])
    expect(result.data).toBe("Yes, your agent's last payment went through. It paid 0.0001 USDC to 0xf463…623c, and Arc has settled it.")
    expect(result.paid).toBe(DEMO_PRICE)
    expect(result.transaction).toBe(TRANSFER_ID)
    // The first line is plain, from the amount actually paid. The seal and the key are under Details.
    expect(result.lines).toEqual([
      'Answer received and checked. You paid 0.001 USDC once.',
      `Detail: ${DELIVERED_SEALED}`,
      'Detail: The key and the answer match the hashes the seller signed for this payment.',
    ])

    expect(boxes).toHaveLength(1)
    const box = boxes[0]!
    expect(box.promise.seller.toLowerCase()).toBe(SELLER.toLowerCase())
    expect(box.promise.buyer.toLowerCase()).toBe(HOLD.toLowerCase())
    expect(box.promise.paymentNonce).toBe(result.nonce as Hex)
    expect(keccak256(stringToBytes(result.body ?? ''))).toBe(box.promise.plaintextHash)
    expect(JSON.parse(result.body ?? '{}')).toEqual({ seller: PAYMENT_CHECK_NAME, answer: result.data })

    expect(claims).toHaveLength(0)
    expect(node.sent).toEqual([])
  })

  test('the key does not come: the agent claims on SealedDelivery from the hold, and the case stays open on Arc', async () => {
    const { node, check, boxes, claims } = await seller(false)
    const result = await check.buy(DEMO_PRICE)

    expect(claims).toHaveLength(1)
    expect(claims[0]).toEqual(boxes[0]!)
    const toContract = node.sent.filter((tx) => tx.to.toLowerCase() === SEALED.toLowerCase())
    expect(toContract.map((tx) => decodeFunctionData({ abi: SEALED_ABI, data: tx.data }).functionName)).toEqual(['claim'])
    expect(result.paid).toBe(DEMO_PRICE)
    expect(result.data).toBe(CLAIM_OPEN)
    expect(result.lines).toEqual([`Detail: Claim ${CLAIM_ID} is open on SealedDelivery ${SEALED}.`])
  })
})

describe('vet402 Balance Check, bought for real against a fake chain', () => {
  test('the same seller wallet seals the balance answer, the box opens to the promise, and the receipt reads plainly', async () => {
    const { node, check, boxes, claims, payers, prices } = await seller(true, 'balance')
    expect(check.candidate.sellerName).toBe(BALANCE_CHECK_NAME)
    const result = await check.buy(DEMO_PRICE)

    expect(payers.map((p) => p.toLowerCase())).toEqual([HOLD.toLowerCase()])
    // The answer is written with this check's own price, to take off the balance Circle shows before settling.
    expect(prices).toEqual([DEMO_PRICE])
    expect(result.data).toBe(BALANCE_ANSWER)
    expect(result.paid).toBe(DEMO_PRICE)
    expect(result.lines).toEqual([
      'Answer received and checked. You paid 0.001 USDC once.',
      `Detail: ${DELIVERED_SEALED}`,
      'Detail: The key and the answer match the hashes the seller signed for this payment.',
    ])
    const box = boxes[0]!
    expect(box.promise.seller.toLowerCase()).toBe(SELLER.toLowerCase())
    expect(keccak256(stringToBytes(result.body ?? ''))).toBe(box.promise.plaintextHash)
    expect(JSON.parse(result.body ?? '{}')).toEqual({ seller: BALANCE_CHECK_NAME, answer: BALANCE_ANSWER })
    expect(claims).toHaveLength(0)
    expect(node.sent).toEqual([])
  })

  test('the key does not come: the same claim on SealedDelivery, against the same seller', async () => {
    const { node, check, claims } = await seller(false, 'balance')
    const result = await check.buy(DEMO_PRICE)
    expect(claims).toHaveLength(1)
    expect(claims[0]!.promise.seller.toLowerCase()).toBe(SELLER.toLowerCase())
    const toContract = node.sent.filter((tx) => tx.to.toLowerCase() === SEALED.toLowerCase())
    expect(toContract.map((tx) => decodeFunctionData({ abi: SEALED_ABI, data: tx.data }).functionName)).toEqual(['claim'])
    expect(result.data).toBe(CLAIM_OPEN)
  })
})
