import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { ChunkSplitter } from '@ethersphere/bee-js'
import {
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  hexToString,
  keccak256,
  numberToHex,
  parseTransaction,
} from 'viem'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { ARC_GATEWAY_WALLET, ARC_USDC } from '../../src/existing/arc-gateway'
import { sealResponse } from '../../src/lib/sealed'
import { preparePayment } from '../gatewayPay'
import type { PreparedPayment } from '../gatewayPay'
import {
  APPROVE_GAS,
  ARC_MEMO,
  CLAIM_GAS,
  CLAIMED_EVENTS,
  claimIdOf,
  claimMemoOf,
  createSealedDelivery,
  createSealedPorts,
  createSealer,
  createSellerWatcher,
  DEFAULT_REFUND_TO_GATEWAY_MIN,
  evidenceRefOf,
  GATEWAY_DEPOSIT_GAS,
  GATEWAY_WALLET_ABI,
  linksFromSellerStore,
  linksOf,
  MEMO_ABI,
  parseRefundMin,
  readClaimMemo,
  SEALED_ABI,
  WITHDRAW_GAS,
} from '../sealedDelivery'
import type { ClaimLinks, PaymentAuth, SealedBox, SealedClient } from '../sealedDelivery'
import { createSeller, DEMO_PRICE } from '../sellers'
import type { SellerFacilitator } from '../sellers'
import { createEvidenceUploader } from '../swarm'

// Arc's Memo contract on a seller's answer, and Circle Gateway's depositFor for money a dispute won back. The chain is a fake
// JSON-RPC node on a local port that records every signed transaction, so nothing reaches a real network.

const CONTRACT: Address = '0x00000000000000000000000000000000000000c1'
const TRANSFER_ID = '1f0c6a52-6a4e-4c41-9d3e-0a4d6b0f1c2e'
const holdKey = generatePrivateKey()
const HOLD = privateKeyToAccount(holdKey).address
const SELLER: Address = '0x00000000000000000000000000000000000000a1'
const NONCE: Hex = `0x${'d'.repeat(64)}`
const sealed = sealResponse('the answer')
const box: SealedBox = {
  ciphertext: sealed.ciphertext,
  promise: {
    seller: SELLER,
    value: '1000',
    paymentNonce: NONCE,
    keyHash: sealed.keyHash,
    plaintextHash: sealed.plaintextHash,
    ciphertextHash: sealed.ciphertextHash,
    expiry: '9999999999',
    buyer: HOLD,
  },
  sellerSignature: '0x11',
}
const auth: PaymentAuth = { from: HOLD, to: SELLER, value: 1000n, validAfter: 0n, validBefore: 9999999999n, nonce: NONCE }
const CLAIM_ID = claimIdOf(SELLER, HOLD, NONCE)

describe('the claim memo', () => {
  test('memoId is the claim id, and the memo names the Gateway transfer, the Swarm box and the Arkiv evidence', () => {
    const ref = 'ab'.repeat(32)
    const memo = claimMemoOf(CLAIM_ID, { gatewayTransferId: TRANSFER_ID, swarmRef: ref })
    expect(memo?.memoId).toBe(CLAIM_ID)
    expect(JSON.parse(hexToString(memo?.memoData ?? '0x'))).toEqual({
      app: 'vet402',
      claimId: CLAIM_ID,
      gatewayTransferId: TRANSFER_ID,
      swarmRef: ref,
      arkiv: { kind: 'evidence', claim_id: CLAIM_ID },
    })
    expect(readClaimMemo(memo?.memoData ?? '0x')).toEqual({ claimId: CLAIM_ID, gatewayTransferId: TRANSFER_ID, swarmRef: ref })
  })

  test('only well formed links go on the chain, and with none there is no memo', () => {
    expect(claimMemoOf(CLAIM_ID, {})).toBeNull()
    expect(claimMemoOf(CLAIM_ID, { gatewayTransferId: '"},{"x":1', swarmRef: 'not-a-ref' })).toBeNull()
    const only = claimMemoOf(CLAIM_ID, { gatewayTransferId: TRANSFER_ID })
    expect(readClaimMemo(only?.memoData ?? '0x')).toEqual({ claimId: CLAIM_ID, gatewayTransferId: TRANSFER_ID })
    expect(readClaimMemo('0x7b7d')).toBeNull()
  })

  // The bytes and the reference of a box that is on Swarm today, uploaded by the filmed run.
  test('the Swarm reference is worked out before the upload and matches a real upload', async () => {
    const real: SealedBox = {
      ...box,
      ciphertext:
        '0x0f66a1bb181f9f0929b488474f660d37f7125e8216c7af5c1437e53c023f103b2600ff3f8213335c247362f58b94be4d6232607a1cf0dede2eb675f9b391e7712a',
      promise: {
        ...box.promise,
        plaintextHash: '0x837f1cfd25f180f03a6edb39e55900dddcff789e13407b49396edbce507ce62b',
        ciphertextHash: '0xeca5529431e5a5bf551325647e046fbc9278c2fa78fdb73fac05c479e3eb2705',
      },
    }
    const ref = await evidenceRefOf(
      real,
      '0x2c880d2b0768269fb827dca6e23aba464c5aa686f62310d4153d0971b8b582a5',
      '0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B',
      5042002,
    )
    expect(ref).toBe('678485f34be28e46bc7791341ea987e149b38b592ff52ad9aecfa6e292696ec8')
  })

  test('the Swarm reference is the one of the exact bytes the uploader sends', async () => {
    let sent: Uint8Array | null = null
    const upload = createEvidenceUploader({
      swarm: {
        upload: (data) => {
          sent = data
          return Promise.resolve('unused')
        },
        download: () => Promise.reject(new Error('unused')),
      },
      contract: CONTRACT,
      chainId: arcTestnet.id,
    })
    await upload(box, CLAIM_ID)
    const expected = (await ChunkSplitter.root(sent as unknown as Uint8Array)).hash().toHex()
    expect(await evidenceRefOf(box, CLAIM_ID, CONTRACT, arcTestnet.id)).toBe(expected)
  })
})

// A JSON-RPC node that answers what viem asks while sending, and keeps every signed transaction.
interface FakeNode {
  url: string
  sent: { to: Address; data: Hex }[]
  code: Map<string, Hex>
  allowance: bigint
  refuseEstimateTo: Address | null
  chainId: number
}

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
})

const claimedLog = () => {
  const event = CLAIMED_EVENTS[1]
  return {
    address: CONTRACT,
    topics: encodeEventTopics({ abi: [event], eventName: 'Claimed', args: { claimId: CLAIM_ID, paymentNonce: NONCE, seller: SELLER } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }], [HOLD, 2000n, 4000n]),
    blockNumber: '0x2',
    transactionHash: `0x${'e'.repeat(64)}`,
    transactionIndex: '0x0',
    blockHash: `0x${'b'.repeat(64)}`,
    logIndex: '0x0',
    removed: false,
  }
}

async function fakeNode(): Promise<FakeNode> {
  const node: FakeNode = { url: '', sent: [], code: new Map(), allowance: 0n, refuseEstimateTo: null, chainId: arcTestnet.id }
  const receipts = new Map<string, { to: Address }>()
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return numberToHex(node.chainId)
      case 'eth_getCode':
        return node.code.get(String(params[0]).toLowerCase()) ?? '0x'
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
      case 'eth_estimateGas': {
        const to = (params[0] as { to?: string }).to?.toLowerCase()
        if (node.refuseEstimateTo && to === node.refuseEstimateTo.toLowerCase()) throw new Error('execution reverted')
        return '0x30000'
      }
      case 'eth_call':
        return encodeAbiParameters([{ type: 'uint256' }], [node.allowance])
      case 'eth_sendRawTransaction': {
        const tx = parseTransaction(params[0] as Hex)
        node.sent.push({ to: tx.to as Address, data: tx.data as Hex })
        const hash = keccak256(params[0] as Hex)
        receipts.set(hash, { to: tx.to as Address })
        return hash
      }
      case 'eth_getTransactionReceipt': {
        const found = receipts.get(String(params[0]))
        if (!found) return null
        const isClaim = found.to.toLowerCase() === CONTRACT.toLowerCase() || found.to.toLowerCase() === ARC_MEMO.toLowerCase()
        return {
          transactionHash: params[0],
          transactionIndex: '0x0',
          blockHash: `0x${'b'.repeat(64)}`,
          blockNumber: '0x2',
          from: HOLD,
          to: found.to,
          cumulativeGasUsed: '0x30000',
          gasUsed: '0x30000',
          effectiveGasPrice: '0x4a817c800',
          contractAddress: null,
          logs: isClaim ? [{ ...claimedLog(), transactionHash: params[0] }] : [],
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
      const calls = JSON.parse(body) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[]
      const one = (call: { id: number; method: string; params: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: call.id, result: answer(call.method, call.params ?? []) }
        } catch (error) {
          const message = (error as Error).message
          // An unknown method is "method not found", so viem takes its usual way instead.
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

const clientOn = (node: FakeNode) => createSealedDelivery({ address: CONTRACT, net: { chain: arcTestnet, rpcUrl: node.url, pollingMs: 5 } })
const CODE: Hex = '0x6080'

const sellerKey = generatePrivateKey()
const KEY: Hex = `0x${'b'.repeat(64)}`

// The seller pays for the memo, on the answer. The buyer's claim stays a plain call, so its gas refund covers all of it.
describe('an answer through Arc Memo', () => {
  test('on Arc the answer goes through Memo, the call inside is the answer, and the memo carries the links', async () => {
    const node = await fakeNode()
    node.code.set(ARC_MEMO.toLowerCase(), CODE)
    const links: ClaimLinks = { gatewayTransferId: TRANSFER_ID, swarmRef: 'cd'.repeat(32) }
    expect(await clientOn(node).answer(sellerKey, CLAIM_ID, KEY, links)).toEqual(links)

    expect(node.sent).toHaveLength(1)
    const tx = node.sent[0]!
    expect(tx.to.toLowerCase()).toBe(ARC_MEMO.toLowerCase())
    const outer = decodeFunctionData({ abi: MEMO_ABI, data: tx.data })
    expect(outer.functionName).toBe('memo')
    const [target, inner, memoId, memoData] = outer.args as [Address, Hex, Hex, Hex]
    expect(target.toLowerCase()).toBe(CONTRACT)
    expect(decodeFunctionData({ abi: SEALED_ABI, data: inner })).toEqual({ functionName: 'answer', args: [CLAIM_ID, KEY] })
    expect(memoId).toBe(CLAIM_ID)
    expect(readClaimMemo(memoData)).toEqual({ claimId: CLAIM_ID, ...links })
  })

  test('where Arc has no Memo contract, as on the local chain, the answer goes straight to the contract', async () => {
    const node = await fakeNode()
    expect(await clientOn(node).answer(sellerKey, CLAIM_ID, KEY, { gatewayTransferId: TRANSFER_ID })).toBeNull()
    expect(node.sent.map((tx) => tx.to.toLowerCase())).toEqual([CONTRACT.toLowerCase()])
    expect(decodeFunctionData({ abi: SEALED_ABI, data: node.sent[0]!.data }).functionName).toBe('answer')
  })

  test('a memo that cannot be sent leaves a plain answer, sent once', async () => {
    const node = await fakeNode()
    node.code.set(ARC_MEMO.toLowerCase(), CODE)
    node.refuseEstimateTo = ARC_MEMO
    expect(await clientOn(node).answer(sellerKey, CLAIM_ID, KEY, { gatewayTransferId: TRANSFER_ID })).toBeNull()
    expect(node.sent.map((tx) => tx.to.toLowerCase())).toEqual([CONTRACT.toLowerCase()])
  })

  test('claim, finalize and prove go straight to the contract even where Arc has Memo', async () => {
    const node = await fakeNode()
    node.code.set(ARC_MEMO.toLowerCase(), CODE)
    const client = clientOn(node)
    await client.claim(holdKey, box, auth, '0x22')
    await client.finalize(holdKey, CLAIM_ID).catch(() => 0n)
    await client.prove(holdKey, CLAIM_ID, sealed.ciphertext, sealed.key).catch(() => 0n)
    expect(node.sent.map((tx) => tx.to.toLowerCase())).toEqual([CONTRACT.toLowerCase(), CONTRACT.toLowerCase(), CONTRACT.toLowerCase()])
    expect(node.sent.map((tx) => decodeFunctionData({ abi: SEALED_ABI, data: tx.data }).functionName)).toEqual(['claim', 'finalize', 'prove'])
  })
})

describe('the links a seller puts on its answer', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  // A real seller writes its file, so a change to that file's shape breaks this test and not the memo.
  test('come from the seller file: the Gateway transfer it settled, and the Swarm reference of the box the buyer keeps', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'answer-links-'))
    dirs.push(dir)
    const file = path.join(dir, 'seller-a.json')
    const facilitator: SellerFacilitator = {
      verify: () => Promise.resolve({ isValid: true }),
      settle: () => Promise.resolve({ success: true, transaction: TRANSFER_ID }),
    }
    const handler = createSeller({
      name: 'Seller A',
      payTo: privateKeyToAccount(sellerKey).address,
      declaresRecovery: true,
      facilitator,
      confirmCharged: () => Promise.resolve(true),
      dropAfterSettle: () => false,
      storeFile: file,
      sealing: { seal: createSealer(clientOn({ url: 'http://127.0.0.1:1' } as FakeNode), sellerKey), handsOverKey: () => true },
    })
    const app = express()
    app.get('/s', (req, res) => {
      handler(req, res).catch(() => res.status(502).end())
    })
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    servers.push(server)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/s`
    const challenge = await preparePayment({ holdKey, holdAvailable: () => Promise.resolve(1_000_000n) }, { url, method: 'GET' }, DEMO_PRICE)
    if (challenge.kind !== 'priced') throw new Error('expected a price')
    const { sealed: sold } = (await (await challenge.payment.send()).json()) as { sealed: SealedBox }

    const claimId = claimIdOf(sold.promise.seller, sold.promise.buyer, sold.promise.paymentNonce)
    const client = { address: CONTRACT, chainId: arcTestnet.id }
    const links = await linksFromSellerStore(file, client)(challenge.payment.nonce.toUpperCase().replace('0X', '0x') as Hex, claimId)
    expect(links).toEqual({ gatewayTransferId: TRANSFER_ID, swarmRef: await evidenceRefOf(sold, claimId, CONTRACT, arcTestnet.id) })
    expect(await linksFromSellerStore(file, client)(`0x${'0'.repeat(64)}`, claimId)).toBeNull()
    expect(await linksFromSellerStore(path.join(dir, 'none.json'), client)(NONCE, claimId)).toBeNull()
    // The public try keeps its seller in memory, and reads the same links from it.
    const paid = handler.paidFor(challenge.payment.nonce)
    expect(paid ? await linksOf(paid, claimId, client) : null).toEqual(links)
    expect(handler.paidFor(`0x${'0'.repeat(64)}`)).toBeNull()
  })

  test('the lookout answers with them, and answers without them when they cannot be found', async () => {
    const sent: (ClaimLinks | undefined)[] = []
    const links: ClaimLinks = { gatewayTransferId: TRANSFER_ID }
    for (const linksFor of [() => Promise.resolve(links), () => Promise.reject(new Error('disk'))]) {
      let block = 10n
      const watcher = createSellerWatcher({
        client: {
          latestBlock: () => Promise.resolve(block++),
          readClaimed: () => Promise.resolve([{ claimId: CLAIM_ID, paymentNonce: NONCE, deadline: 200n, seller: SELLER, transactionHash: '0x' }] as never),
          answer: (_key, _id, _k, l) => {
            sent.push(l)
            return Promise.resolve(null)
          },
          tryAnswer: () => Promise.resolve(null),
          chainTime: () => Promise.resolve(100n),
        },
        sellerKey,
        keyFor: () => KEY,
        mode: 'answer',
        linksFor,
      })
      await watcher.tick()
    }
    expect(sent).toEqual([links, undefined])
  })
})

describe("Circle Gateway's depositFor", () => {
  test('approves exactly the amount, then deposits it for the hold', async () => {
    const node = await fakeNode()
    node.code.set(ARC_GATEWAY_WALLET.toLowerCase(), CODE)
    expect(await clientOn(node).depositToGateway(holdKey, HOLD, 13268n)).not.toBeNull()

    expect(node.sent.map((tx) => tx.to.toLowerCase())).toEqual([ARC_USDC.toLowerCase(), ARC_GATEWAY_WALLET.toLowerCase()])
    const approve = decodeFunctionData({ abi: erc20Abi, data: node.sent[0]!.data })
    expect(approve).toEqual({ functionName: 'approve', args: [ARC_GATEWAY_WALLET, 13268n] })
    const deposit = decodeFunctionData({ abi: GATEWAY_WALLET_ABI, data: node.sent[1]!.data })
    expect(deposit).toEqual({ functionName: 'depositFor', args: [ARC_USDC, HOLD, 13268n] })
  })

  test('with enough allowance it only deposits', async () => {
    const node = await fakeNode()
    node.code.set(ARC_GATEWAY_WALLET.toLowerCase(), CODE)
    node.allowance = 13268n
    await clientOn(node).depositToGateway(holdKey, HOLD, 13268n)
    expect(node.sent.map((tx) => tx.to.toLowerCase())).toEqual([ARC_GATEWAY_WALLET.toLowerCase()])
  })

  test("on Arc mainnet it deposits into mainnet's Gateway wallet", async () => {
    const MAINNET_GATEWAY = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'
    const node = await fakeNode()
    node.chainId = 5042
    node.code.set(MAINNET_GATEWAY.toLowerCase(), CODE)
    node.allowance = 1n << 64n
    const mainnet = defineChain({ ...arcTestnet, id: 5042, testnet: false })
    const client = createSealedDelivery({ address: CONTRACT, net: { chain: mainnet, rpcUrl: node.url, pollingMs: 5 } })
    await client.depositToGateway(holdKey, HOLD, 13268n)
    expect(node.sent.map((tx) => tx.to.toLowerCase())).toEqual([MAINNET_GATEWAY.toLowerCase()])
  })

  test('where there is no Gateway, nothing is sent', async () => {
    const node = await fakeNode()
    expect(await clientOn(node).depositToGateway(holdKey, HOLD, 13268n)).toBeNull()
    expect(node.sent).toEqual([])
  })
})

// The ports with a fake client: the claim stays plain, and refunds go back into Gateway only once enough has come back.
function fakeClient(over: { gateway?: boolean; balance?: bigint; gasCost?: bigint; claimable?: bigint; refundMin?: bigint } = {}) {
  const log = {
    fills: [] as bigint[],
    claims: 0,
    deposits: [] as { depositor: Address; amount: bigint }[],
  }
  const client = {
    address: CONTRACT,
    chainId: arcTestnet.id,
    memoReady: () => Promise.resolve(true),
    gatewayReady: () => Promise.resolve(over.gateway ?? true),
    // gasCost(gas) is the gas in micro USDC, so the fills read as gas.
    gasCost: (gas: bigint) => Promise.resolve(over.gasCost ?? gas),
    usdcBalance: () => Promise.resolve(over.balance ?? 10_000_000n),
    claimable: () => Promise.resolve(over.claimable ?? 13268n),
    ensureGas: (_from: Hex, _to: Address, gas: bigint) => {
      log.fills.push(gas)
      return Promise.resolve(0n)
    },
    claim: () => {
      log.claims++
      return Promise.resolve({ claimId: CLAIM_ID, deadline: 4000n, fromBlock: 2n, gasUsed: 1n, transactionHash: '0x01' as Hex })
    },
    withdrawClaimable: () => Promise.resolve(over.claimable ?? 13268n),
    depositToGateway: (_key: Hex, depositor: Address, amount: bigint) => {
      log.deposits.push({ depositor, amount })
      return Promise.resolve('0x02' as Hex)
    },
  }
  const ports = createSealedPorts({
    client: client as unknown as SealedClient,
    holdKey,
    buyerKey: generatePrivateKey(),
    rejected: new Set(),
    refundMin: over.refundMin ?? 50_000n,
  })
  return { ports, log }
}

const header = Buffer.from(
  JSON.stringify({
    payload: {
      signature: '0x22',
      authorization: { from: HOLD, to: SELLER, value: '1000', validAfter: '0', validBefore: '9999999999', nonce: NONCE },
    },
  }),
).toString('base64')
const payment = { header: { name: 'PAYMENT-SIGNATURE', value: header } } as unknown as PreparedPayment

describe('the sealed ports', () => {
  test('the claim is filled and sent as before, with no memo', async () => {
    const { ports, log } = fakeClient()
    await ports.claim(box, payment)
    expect(log).toMatchObject({ claims: 1, fills: [CLAIM_GAS] })
  })

  test('REFUND_TO_GATEWAY_MIN is read in USDC, and a missing or unreadable value gives 0.05 USDC', () => {
    expect(parseRefundMin('0.1')).toBe(100_000n)
    expect(parseRefundMin('2')).toBe(2_000_000n)
    expect(DEFAULT_REFUND_TO_GATEWAY_MIN).toBe(50_000n)
    for (const bad of [undefined, '', 'abc', '-1', '0.0000001']) expect(parseRefundMin(bad)).toBe(50_000n)
  })

  test('refunds below the threshold wait in the wallet, and go back together once they reach it', async () => {
    const { ports, log } = fakeClient()
    expect(await ports.backToGateway?.(13268n)).toBe(0n)
    expect(await ports.backToGateway?.(20000n)).toBe(0n)
    expect(log.deposits).toEqual([])
    expect(await ports.backToGateway?.(16732n)).toBe(50_000n)
    expect(log.deposits).toEqual([{ depositor: HOLD, amount: 50_000n }])
    // The count starts again from zero.
    expect(await ports.backToGateway?.(13268n)).toBe(0n)
    expect(log.deposits).toHaveLength(1)
  })

  test('withdraw brings in the deposit gas only when this credit brings the refunds to the threshold', async () => {
    const small = fakeClient({ claimable: 13268n })
    await small.ports.withdraw()
    expect(small.log.fills).toEqual([WITHDRAW_GAS])
    const big = fakeClient({ claimable: 60_000n })
    await big.ports.withdraw()
    expect(big.log.fills).toEqual([WITHDRAW_GAS + APPROVE_GAS + GATEWAY_DEPOSIT_GAS])
    const noGateway = fakeClient({ gateway: false, claimable: 60_000n })
    await noGateway.ports.withdraw()
    expect(noGateway.log.fills).toEqual([WITHDRAW_GAS])
  })

  test('a wallet that holds less than the count, after a new hold swept it, deposits only what is there, and only past the threshold', async () => {
    const swept = fakeClient({ balance: 5000n + 40_000n, gasCost: 5000n })
    expect(await swept.ports.backToGateway?.(60_000n)).toBe(0n)
    const enough = fakeClient({ balance: 5000n + 55_000n, gasCost: 5000n })
    expect(await enough.ports.backToGateway?.(60_000n)).toBe(55_000n)
    expect([...swept.log.deposits, ...enough.log.deposits]).toEqual([{ depositor: HOLD, amount: 55_000n }])
  })

  test('nothing is deposited where there is no Gateway', async () => {
    const none = fakeClient({ gateway: false })
    expect(await none.ports.backToGateway?.(60_000n)).toBe(0n)
    expect(none.log.deposits).toEqual([])
  })
})
