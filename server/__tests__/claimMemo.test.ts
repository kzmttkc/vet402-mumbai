import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
  evidenceRefOf,
  GATEWAY_DEPOSIT_GAS,
  GATEWAY_WALLET_ABI,
  MEMO_ABI,
  MEMO_GAS,
  readClaimMemo,
  SEALED_ABI,
  WITHDRAW_GAS,
} from '../sealedDelivery'
import type { ClaimLinks, PaymentAuth, SealedBox, SealedClient } from '../sealedDelivery'
import { createEvidenceUploader } from '../swarm'

// Arc's Memo contract on a claim, and Circle Gateway's depositFor for money a dispute won back. The chain is a fake
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
  for (const server of servers.splice(0)) server.close()
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

describe('a claim through Arc Memo', () => {
  test('on Arc the claim goes through Memo, the call inside is the claim, and the memo carries the links', async () => {
    const node = await fakeNode()
    node.code.set(ARC_MEMO.toLowerCase(), CODE)
    const links: ClaimLinks = { gatewayTransferId: TRANSFER_ID, swarmRef: 'cd'.repeat(32) }
    const result = await clientOn(node).claim(holdKey, box, auth, '0x22', links)

    expect(node.sent).toHaveLength(1)
    const tx = node.sent[0]!
    expect(tx.to.toLowerCase()).toBe(ARC_MEMO.toLowerCase())
    const outer = decodeFunctionData({ abi: MEMO_ABI, data: tx.data })
    expect(outer.functionName).toBe('memo')
    const [target, inner, memoId, memoData] = outer.args as [Address, Hex, Hex, Hex]
    expect(target.toLowerCase()).toBe(CONTRACT)
    expect(decodeFunctionData({ abi: SEALED_ABI, data: inner }).functionName).toBe('claim')
    expect(memoId).toBe(CLAIM_ID)
    expect(readClaimMemo(memoData)).toEqual({ claimId: CLAIM_ID, ...links })
    expect(result).toMatchObject({ claimId: CLAIM_ID, memo: links })
  })

  test('where Arc has no Memo contract, as on the local chain, the claim goes straight to the contract', async () => {
    const node = await fakeNode()
    const result = await clientOn(node).claim(holdKey, box, auth, '0x22', { gatewayTransferId: TRANSFER_ID })
    expect(node.sent.map((tx) => tx.to.toLowerCase())).toEqual([CONTRACT.toLowerCase()])
    expect(decodeFunctionData({ abi: SEALED_ABI, data: node.sent[0]!.data }).functionName).toBe('claim')
    expect(result.memo).toBeNull()
  })

  test('a memo that cannot be sent leaves a plain claim, sent once', async () => {
    const node = await fakeNode()
    node.code.set(ARC_MEMO.toLowerCase(), CODE)
    node.refuseEstimateTo = ARC_MEMO
    const result = await clientOn(node).claim(holdKey, box, auth, '0x22', { gatewayTransferId: TRANSFER_ID })
    expect(node.sent.map((tx) => tx.to.toLowerCase())).toEqual([CONTRACT.toLowerCase()])
    expect(result).toMatchObject({ claimId: CLAIM_ID, memo: null })
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

// The ports with a fake client: what the claim is sent with, and what goes back into Gateway.
function fakeClient(over: { memo?: boolean; gateway?: boolean; balance?: bigint; gasCost?: bigint } = {}) {
  const log = {
    fills: [] as bigint[],
    claims: [] as (ClaimLinks | undefined)[],
    deposits: [] as { depositor: Address; amount: bigint }[],
  }
  const client = {
    address: CONTRACT,
    chainId: arcTestnet.id,
    memoReady: () => Promise.resolve(over.memo ?? true),
    gatewayReady: () => Promise.resolve(over.gateway ?? true),
    // gasCost(gas) is the gas in micro USDC, so the fills read as gas.
    gasCost: (gas: bigint) => Promise.resolve(over.gasCost ?? gas),
    usdcBalance: () => Promise.resolve(over.balance ?? 0n),
    ensureGas: (_from: Hex, _to: Address, gas: bigint) => {
      log.fills.push(gas)
      return Promise.resolve(0n)
    },
    claim: (_key: Hex, _box: SealedBox, _auth: PaymentAuth, _sig: Hex, links?: ClaimLinks) => {
      log.claims.push(links)
      return Promise.resolve({ claimId: CLAIM_ID, deadline: 4000n, fromBlock: 2n, gasUsed: 1n, transactionHash: '0x01' as Hex, memo: links ?? null })
    },
    withdrawClaimable: () => Promise.resolve(13268n),
    depositToGateway: (_key: Hex, depositor: Address, amount: bigint) => {
      log.deposits.push({ depositor, amount })
      return Promise.resolve('0x02' as Hex)
    },
  }
  const ports = createSealedPorts({ client: client as unknown as SealedClient, holdKey, buyerKey: generatePrivateKey(), rejected: new Set() })
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
  test('a claim on Arc carries the Gateway transfer and the reference the box will have on Swarm, with gas for the memo', async () => {
    const { ports, log } = fakeClient()
    const claim = await ports.claim(box, payment, { gatewayTransferId: TRANSFER_ID, keepsEvidence: true })
    const swarmRef = await evidenceRefOf(box, CLAIM_ID, CONTRACT, arcTestnet.id)
    expect(log.claims).toEqual([{ gatewayTransferId: TRANSFER_ID, swarmRef }])
    expect(log.fills).toEqual([CLAIM_GAS + MEMO_GAS])
    expect(claim.memo).toEqual({ gatewayTransferId: TRANSFER_ID, swarmRef })
  })

  test('without Memo on the chain, or without a request, the claim is plain and filled as before', async () => {
    const noMemo = fakeClient({ memo: false })
    await noMemo.ports.claim(box, payment, { gatewayTransferId: TRANSFER_ID, keepsEvidence: true })
    expect(noMemo.log).toMatchObject({ claims: [undefined], fills: [CLAIM_GAS] })
    const noRequest = fakeClient()
    await noRequest.ports.claim(box, payment)
    expect(noRequest.log).toMatchObject({ claims: [undefined], fills: [CLAIM_GAS] })
  })

  test('withdraw brings in the gas for the Gateway deposit too, so all of the refund can go back', async () => {
    const { ports, log } = fakeClient()
    expect(await ports.withdraw()).toBe(13268n)
    expect(log.fills).toEqual([WITHDRAW_GAS + APPROVE_GAS + GATEWAY_DEPOSIT_GAS])
    const noGateway = fakeClient({ gateway: false })
    await noGateway.ports.withdraw()
    expect(noGateway.log.fills).toEqual([WITHDRAW_GAS])
  })

  test('the whole refund goes back into the hold Gateway balance when the wallet can also pay the deposit', async () => {
    const { ports, log } = fakeClient({ balance: 13268n + 5000n, gasCost: 5000n })
    expect(await ports.backToGateway?.(13268n)).toBe(13268n)
    expect(log.deposits).toEqual([{ depositor: HOLD, amount: 13268n }])
  })

  test('when the wallet holds only the refund, the deposit gas comes out of it and the rest goes back', async () => {
    const { ports, log } = fakeClient({ balance: 13268n, gasCost: 5000n })
    expect(await ports.backToGateway?.(13268n)).toBe(8268n)
    expect(log.deposits).toEqual([{ depositor: HOLD, amount: 8268n }])
  })

  test('nothing is deposited where there is no Gateway, or when the gas would take it all', async () => {
    const none = fakeClient({ gateway: false, balance: 99999n })
    expect(await none.ports.backToGateway?.(13268n)).toBe(0n)
    const dust = fakeClient({ balance: 4000n, gasCost: 5000n })
    expect(await dust.ports.backToGateway?.(4000n)).toBe(0n)
    expect([...none.log.deposits, ...dust.log.deposits]).toEqual([])
  })
})
