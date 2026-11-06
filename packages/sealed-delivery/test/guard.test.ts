// The seller's guard: the buyer's record read from Claimed and KeyRevealed, and the middleware's two actions.
import { describe, expect, test } from 'bun:test'
import express from 'express'
import { encodeAbiParameters, encodeEventTopics, keccak256, numberToHex, stringToHex } from 'viem'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createLocalFacilitator, createLocalPayer } from '../examples/localPayment'
import { CLAIMED_EVENTS } from '../src/common'
import { buyerClaimRecord, SEALED_DELIVERY_ABI, sealedDelivery } from './imports'
import type { PaymentRequirement, SealedBox, SealedChain } from '../src/index'
import { CHAIN_ID, CONTRACT, DOMAIN, offlineChain, serve } from './helpers'

const sellerKey = generatePrivateKey()
const seller = privateKeyToAccount(sellerKey).address
const otherSeller: Address = '0x00000000000000000000000000000000000000a2'
const grieferKey = generatePrivateKey()
const griefer = privateKeyToAccount(grieferKey)
const bystander: Address = '0x00000000000000000000000000000000000000b3'

const CLAIMED = CLAIMED_EVENTS[1]
const KEY_REVEALED_TOPIC = encodeEventTopics({ abi: SEALED_DELIVERY_ABI, eventName: 'KeyRevealed' })[0] as Hex
const idOf = (n: number) => keccak256(stringToHex(`claim ${n}`))

interface RawLog {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: bigint
}

function claimedLog(n: number, block: bigint, buyer: Address, sellerAddress: Address): RawLog {
  return {
    address: CONTRACT,
    topics: encodeEventTopics({ abi: [CLAIMED], eventName: 'Claimed', args: { claimId: idOf(n), paymentNonce: idOf(1000 + n), seller: sellerAddress } }) as Hex[],
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }], [buyer, 112_000n, 9_999_999n]),
    blockNumber: block,
  }
}

function keyRevealedLog(n: number, block: bigint): RawLog {
  return {
    address: CONTRACT,
    topics: [KEY_REVEALED_TOPIC, idOf(n), idOf(1000 + n)],
    data: encodeAbiParameters([{ type: 'bytes' }], [keccak256(stringToHex(`key ${n}`))]),
    blockNumber: block,
  }
}

/** A JSON-RPC node that answers eth_getLogs from a fixed list, honouring the block range and the topic filters. */
function logNode(latest: bigint, logs: RawLog[]) {
  const calls: { from: bigint; to: bigint }[] = []
  const matches = (wanted: Hex | Hex[] | null | undefined, have: Hex | undefined) =>
    wanted == null || (Array.isArray(wanted) ? wanted.map((w) => w.toLowerCase()) : [wanted.toLowerCase()]).includes(have?.toLowerCase() ?? '')
  const app = express()
  app.use(express.json())
  app.post('/', (req, res) => {
    const { id, method, params } = req.body as { id: number; method: string; params: Record<string, unknown>[] }
    const reply = (result: unknown) => res.json({ jsonrpc: '2.0', id, result })
    if (method === 'eth_chainId') return reply(numberToHex(CHAIN_ID))
    if (method === 'eth_blockNumber') return reply(numberToHex(latest))
    if (method !== 'eth_getLogs') return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: method } })
    const filter = params[0] as { fromBlock: Hex; toBlock: Hex; topics?: (Hex | Hex[] | null)[] }
    const from = BigInt(filter.fromBlock)
    const to = BigInt(filter.toBlock)
    calls.push({ from, to })
    const found = logs
      .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
      .filter((log) => (filter.topics ?? []).every((wanted, i) => matches(wanted, log.topics[i])))
      .map((log, i) => ({
        ...log,
        blockNumber: numberToHex(log.blockNumber),
        blockHash: keccak256(numberToHex(log.blockNumber)),
        transactionHash: keccak256(stringToHex(`tx ${log.blockNumber} ${i}`)),
        transactionIndex: '0x0',
        logIndex: numberToHex(i),
        removed: false,
      }))
    return reply(found)
  })
  return serve(app).then((server) => ({ ...server, calls }))
}

describe('buyerClaimRecord', () => {
  test('counts the buyer’s claims from Claimed, and which of its latest ones a seller answered from KeyRevealed', async () => {
    const logs = [
      claimedLog(1, 5n, griefer.address, seller),
      claimedLog(2, 9n, bystander, seller),
      keyRevealedLog(1, 6n),
      claimedLog(3, 12n, griefer.address, otherSeller),
      keyRevealedLog(3, 13n),
      claimedLog(4, 18n, griefer.address, seller),
      claimedLog(5, 22n, griefer.address, seller),
      keyRevealedLog(5, 23n),
      claimedLog(6, 27n, griefer.address, otherSeller),
      claimedLog(7, 31n, griefer.address, seller),
      keyRevealedLog(7, 32n),
    ]
    const node = await logNode(35n, logs)
    try {
      const record = await buyerClaimRecord(griefer.address, { contract: CONTRACT, rpcUrl: node.url, fromBlock: 0n, last: 5, blockStep: 10n })
      expect(record.claims).toBe(6)
      expect(record.recent.map((c) => [c.claimId, c.block, c.answered])).toEqual([
        [idOf(7), 31n, true],
        [idOf(6), 27n, false],
        [idOf(5), 22n, true],
        [idOf(4), 18n, false],
        [idOf(3), 12n, true],
      ])
      expect(record.answered).toBe(3)
      // Paged: no call spans more than ten blocks.
      expect(node.calls.every((c) => c.to - c.from < 10n)).toBe(true)

      const here = await buyerClaimRecord(griefer.address, { contract: CONTRACT, rpcUrl: node.url, fromBlock: 0n, seller, blockStep: 10n })
      expect(here.claims).toBe(4)
      expect(here.answered).toBe(3)

      const clean = await buyerClaimRecord(bystander, { contract: CONTRACT, rpcUrl: node.url, fromBlock: 0n })
      expect(clean).toEqual({ buyer: bystander, claims: 1, recent: [{ claimId: idOf(2), seller, block: 9n, answered: false }], answered: 0 })
    } finally {
      node.close()
    }
  })
})

describe('the claim guard in the middleware', () => {
  const accepts: PaymentRequirement = {
    scheme: 'exact',
    network: `eip155:${CHAIN_ID}`,
    asset: '0x3600000000000000000000000000000000000000',
    amount: '1000',
    payTo: seller,
  }
  /** A chain where the griefer's three latest claims were all answered and nobody else ever claimed. */
  function recordChain(fail = false): SealedChain {
    const chain = offlineChain()
    return Object.assign(Object.create(chain) as SealedChain, {
      readClaimsBy: async (buyer: Address) => {
        if (fail) throw new Error('node down')
        return buyer.toLowerCase() === griefer.address.toLowerCase()
          ? [1, 2, 3].map((n) => ({ claimId: idOf(n), seller, block: BigInt(n) }))
          : []
      },
      readAnswered: async (ids: readonly Hex[]) => new Set(ids.map((id) => id.toLowerCase() as Hex)),
    })
  }
  async function shop(claimGuard: Parameters<typeof sealedDelivery>[0]['claimGuard'], fail = false) {
    const { facilitator, settled } = createLocalFacilitator(DOMAIN)
    const logged: string[] = []
    const sealed = sealedDelivery({
      contract: CONTRACT,
      sellerKey,
      facilitator,
      accepts,
      rpcUrl: '',
      watch: false,
      chain: recordChain(fail),
      claimGuard,
      log: (m) => logged.push(m),
    })
    const app = express()
    app.use('/answer', sealed)
    app.get('/answer', (_req, res) => res.json({ answer: 42 }))
    const server = await serve(app)
    return { url: `${server.url}/answer`, settled, logged, close: server.close }
  }
  const get = (url: string, header: string) => fetch(url, { headers: { 'PAYMENT-SIGNATURE': header } })

  test('refuse: no sealed box and no charge for a buyer whose latest claims were answered; others are served', async () => {
    const s = await shop({ fromBlock: 0n })
    try {
      const refused = await get(s.url, await createLocalPayer(grieferKey, DOMAIN)(accepts))
      expect(refused.status).toBe(403)
      expect(((await refused.json()) as { error: string }).error).toContain('No sealed answer for this payer')
      expect(s.settled.size).toBe(0)

      const served = await get(s.url, await createLocalPayer(generatePrivateKey(), DOMAIN)(accepts))
      expect(served.status).toBe(200)
      expect(((await served.json()) as { sealed: SealedBox }).sealed.ciphertext).toMatch(/^0x/)
      expect(s.settled.size).toBe(1)
    } finally {
      s.close()
    }
  })

  test('a higher bar lets the same buyer through', async () => {
    const s = await shop({ fromBlock: 0n, answeredAtLeast: 4 })
    try {
      expect((await get(s.url, await createLocalPayer(grieferKey, DOMAIN)(accepts))).status).toBe(200)
      expect(s.settled.size).toBe(1)
    } finally {
      s.close()
    }
  })

  test('surcharge: the plain price gets a 402 for the higher amount, and the higher amount gets a sealed box', async () => {
    const s = await shop({ fromBlock: async () => 0n, action: { surcharge: 10_000n } })
    try {
      const pay = createLocalPayer(grieferKey, DOMAIN)
      const asked = await get(s.url, await pay(accepts))
      expect(asked.status).toBe(402)
      const body = (await asked.json()) as { accepts: PaymentRequirement[]; error: string }
      expect(body.accepts).toEqual([{ ...accepts, amount: '11000' }])
      expect(body.error).toBe('This payer pays more for a sealed answer')
      expect(s.settled.size).toBe(0)

      const paid = await get(s.url, await pay(body.accepts[0]!))
      expect(paid.status).toBe(200)
      const { sealed } = (await paid.json()) as { sealed: SealedBox }
      expect(BigInt(sealed.promise.value)).toBe(11_000n)
      expect(s.settled.size).toBe(1)

      // Anyone else still pays the plain price.
      expect((await get(s.url, await createLocalPayer(generatePrivateKey(), DOMAIN)(accepts))).status).toBe(200)
    } finally {
      s.close()
    }
  })

  test('a record that cannot be read logs and lets the sale go on', async () => {
    const s = await shop({ fromBlock: 0n }, true)
    try {
      expect((await get(s.url, await createLocalPayer(grieferKey, DOMAIN)(accepts))).status).toBe(200)
      expect(s.logged.some((m) => m.startsWith('claim guard could not read'))).toBe(true)
    } finally {
      s.close()
    }
  })
})
