import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  fallback,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  hexToString,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  recoverTypedDataAddress,
  stringToHex,
} from 'viem'
import type { Address, Chain, Hex, TransactionReceipt } from 'viem'
import { arcTestnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_USDC } from '../src/existing/arc-gateway'
import { sealResponse } from '../src/lib/sealed'
import { getChain, getProtocolContractByName, requireChain } from '../src/onchain-facts'
import type { PreparedPayment } from './gatewayPay'
import { createSeller } from './sellers'
import type { SellerFacilitator, SellerSealing } from './sellers'
import { sendOnce } from './sendOnce'

// Everything that touches SealedDelivery on a chain. The chain is a parameter, so the local
// run can point the same code at anvil. Money is always the 6-decimal ERC-20, never msg.value.

export const SEALED_ABI = parseAbi([
  'struct SealedPromise { address seller; uint256 value; bytes32 paymentNonce; bytes32 keyHash; bytes32 plaintextHash; bytes32 ciphertextHash; uint64 expiry; address buyer; }',
  'struct PaymentAuth { address from; address to; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; }',
  'function claim(SealedPromise p, bytes sellerSignature, PaymentAuth auth, bytes buyerSignature)',
  'function answer(bytes32 claimId, bytes key)',
  'function finalize(bytes32 claimId)',
  'function prove(bytes32 claimId, bytes ciphertext, bytes key)',
  'function deposit(uint256 amount)',
  'function withdrawClaimable()',
  'function coverage(address seller) view returns (uint256)',
  'function coverageFor(address seller, uint256 value) view returns (bool)',
  'function deposits(address seller) view returns (uint256)',
  'function claimable(address buyer) view returns (uint256)',
  'function flushBurn()',
  'function silentCount(address seller) view returns (uint256)',
  'function fraudCount(address seller) view returns (uint256)',
  'function MAX_DISPUTE_COST() view returns (uint256)',
  'function gasRefundOf(bytes32 claimId) view returns (uint256)',
  'function claims(bytes32 claimId) view returns (address seller, address buyer, uint256 liability, uint64 deadline, bytes32 keyHash, uint8 status, bytes32 paymentNonce, bytes32 plaintextHash, bytes32 ciphertextHash)',
  'event KeyRevealed(bytes32 indexed claimId, bytes32 indexed paymentNonce, bytes key)',
  'event Silent(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)',
  'event Fraud(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)',
  'event ClaimableWithdrawn(address indexed buyer, uint256 amount)',
  'event ClaimGasRepaid(bytes32 indexed claimId, address indexed buyer, uint256 amount, bool sent)',
  'error InvalidSellerSignature()',
  'error InvalidBuyerSignature()',
  'error NotBuyer()',
  'error WrongBuyer()',
  'error WrongPayee()',
  'error WrongValue()',
  'error WrongNonce()',
  'error PaymentNotYetValid()',
  'error PaymentNeverValid()',
  'error PromiseExpired()',
  'error ExpiryTooFar()',
  'error AlreadyClaimed()',
  'error NotOpen()',
  'error AnswerWindowClosed()',
  'error WrongKey()',
  'error NotProvable()',
  'error AlreadyFraud()',
  'error WrongCiphertext()',
  'error PromiseKept()',
  'error DeadlineNotReached()',
  'error ZeroAmount()',
  'error NothingToWithdraw()',
])

/** Arc's predeployed Memo contract. It runs a call as the wallet that sent it and logs the memo right after the call. */
export const ARC_MEMO: Address = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505'

export const MEMO_ABI = parseAbi([
  'function memo(address target, bytes data, bytes32 memoId, bytes memoData)',
  'event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)',
])

/** Circle Gateway's wallet contract: depositFor credits the depositor's Gateway balance. */
export const GATEWAY_WALLET_ABI = parseAbi(['function depositFor(address token, address depositor, uint256 value)'])

/**
 * Claimed, with and without the reserved amount, because the contract is dropping it. Nothing here
 * reads that amount: only the claim id, nonce, seller and deadline, which both shapes carry.
 */
export const CLAIMED_EVENTS = [
  parseAbiItem(
    'event Claimed(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint64 deadline)',
  ),
  parseAbiItem(
    'event Claimed(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 reserved, uint64 deadline)',
  ),
] as const

const PROMISE_TYPES = {
  Promise: [
    { name: 'seller', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'paymentNonce', type: 'bytes32' },
    { name: 'keyHash', type: 'bytes32' },
    { name: 'plaintextHash', type: 'bytes32' },
    { name: 'ciphertextHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
    { name: 'buyer', type: 'address' },
  ],
} as const

/** A promise lives this long. The contract refuses one further out than its MAX_EXPIRY. */
export const PROMISE_SECONDS = 3000

// Upper bounds on the gas of each call, measured on the local run and rounded up.
export const CLAIM_GAS = 320_000n
/** An answer also sends the buyer its claim gas back, which costs the seller a USDC transfer. */
export const ANSWER_GAS = 150_000n
export const APPROVE_GAS = 60_000n
export const DEPOSIT_GAS = 100_000n
export const FINALIZE_GAS = 160_000n
export const WITHDRAW_GAS = 80_000n
/** prove() decrypts in a loop, so its bound leaves room for a small cached answer. */
export const PROVE_GAS = 200_000n
/** A Gateway deposit. On Arc testnet one used 87,551. */
export const GATEWAY_DEPOSIT_GAS = 120_000n
/** Gas prices move, so every estimate keeps a cushion. */
const FEE_CUSHION = 2n
/** Gas is counted in 18 decimals, USDC in 6. */
const GAS_UNITS_PER_USDC_UNIT = 10n ** 12n

const TX_TIMEOUT_MS = 60_000
const REFUSED_ANSWER_GAS = 120_000n

export interface SealedPromise {
  seller: Address
  value: bigint
  paymentNonce: Hex
  keyHash: Hex
  plaintextHash: Hex
  ciphertextHash: Hex
  expiry: bigint
  buyer: Address
}

/** What goes over HTTP: the promise with its big numbers as strings. */
export interface SealedBox {
  ciphertext: Hex
  promise: Omit<SealedPromise, 'value' | 'expiry'> & { value: string; expiry: string }
  sellerSignature: Hex
}

export interface PaymentAuth {
  from: Address
  to: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

/** Where to reach the contract. The real one is Arc testnet; the local run passes anvil. */
export interface SealedNet {
  chain: Chain
  rpcUrl: string
  pollingMs?: number
}

/** Arc testnet's public nodes, in the order to try them. */
export const ARC_RPC_URLS = ['https://rpc.testnet.arc.io', 'https://rpc.testnet.arc.network', 'https://arc-testnet.drpc.org']

export const ARC_NET: SealedNet = { chain: arcTestnet, rpcUrl: requireChain(5042002).rpcUrls[0]! }

/** Null when the variable is missing or not an address. The app then behaves as it did before. */
export function parseSealedAddress(value: string | undefined): Address | null {
  return value && isAddress(value) ? value : null
}

export const claimIdOf = (seller: Address, buyer: Address, paymentNonce: Hex): Hex =>
  keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [seller, buyer, paymentNonce]),
  )

/** The name of the contract error behind a failed call, or null when it failed some other way. */
export function revertNameOf(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : null
}

export const boxToPromise = (box: SealedBox): SealedPromise => ({
  ...box.promise,
  value: BigInt(box.promise.value),
  expiry: BigInt(box.promise.expiry),
})

/** The signed authorization inside a payment header, which claim() needs back. */
export function paymentAuthOf(headerValue: string): { auth: PaymentAuth; signature: Hex } {
  const parsed = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')) as {
    payload: { signature: Hex; authorization: Record<'from' | 'to' | 'value' | 'validAfter' | 'validBefore' | 'nonce', string> }
  }
  const a = parsed.payload.authorization
  return {
    signature: parsed.payload.signature,
    auth: {
      from: a.from as Address,
      to: a.to as Address,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce as Hex,
    },
  }
}

/** What the memo on a claim's answer points to, beside the claim id that is its memoId. */
export interface ClaimLinks {
  /** Circle Gateway's id for the transfer the claim is about. */
  gatewayTransferId?: string
  /** The Swarm reference of the buyer's evidence box, which the seller works out from its own box: Swarm addresses data by its content. */
  swarmRef?: string
}

const TRANSFER_ID = /^[0-9A-Za-z-]{1,64}$/
const SWARM_REF = /^[0-9a-f]{64}$/

/** Only well formed links go on the chain. */
const cleanLinks = (links: ClaimLinks): ClaimLinks => ({
  ...(links.gatewayTransferId && TRANSFER_ID.test(links.gatewayTransferId) ? { gatewayTransferId: links.gatewayTransferId } : {}),
  ...(links.swarmRef && SWARM_REF.test(links.swarmRef) ? { swarmRef: links.swarmRef } : {}),
})

/**
 * The memo a seller's answer carries on Arc, paid by the seller. The memoId is the claim id, so an indexer finds it by the claim, and the memo is
 * JSON an explorer shows as text: the Gateway transfer, the Swarm box, and the Arkiv evidence entity that names this
 * claim id. Null when there is nothing to point to.
 */
export function claimMemoOf(claimId: Hex, links: ClaimLinks): { memoId: Hex; memoData: Hex } | null {
  const clean = cleanLinks(links)
  if (!clean.gatewayTransferId && !clean.swarmRef) return null
  const body = {
    app: 'vet402',
    claimId,
    ...(clean.gatewayTransferId ? { gatewayTransferId: clean.gatewayTransferId } : {}),
    ...(clean.swarmRef ? { swarmRef: clean.swarmRef, arkiv: { kind: 'evidence', claim_id: claimId } } : {}),
  }
  return { memoId: claimId, memoData: stringToHex(JSON.stringify(body)) }
}

/** Reads a claim memo back. Null for a memo vet402 did not write. */
export function readClaimMemo(memoData: Hex): (ClaimLinks & { claimId: Hex }) | null {
  try {
    const body = JSON.parse(hexToString(memoData)) as Record<string, unknown>
    if (body.app !== 'vet402' || typeof body.claimId !== 'string') return null
    return {
      claimId: body.claimId as Hex,
      ...cleanLinks({
        gatewayTransferId: typeof body.gatewayTransferId === 'string' ? body.gatewayTransferId : undefined,
        swarmRef: typeof body.swarmRef === 'string' ? body.swarmRef : undefined,
      }),
    }
  } catch {
    return null
  }
}

/**
 * The reference Swarm gives the evidence box, worked out before the upload: the same bytes the uploader sends, hashed
 * into Swarm's chunk tree. Swarm is loaded here only, so the SDK that shares this file needs no Swarm.
 */
export async function evidenceRefOf(box: SealedBox, claimId: Hex, contract: string, chainId: number): Promise<string> {
  const [{ ChunkSplitter }, { createEvidenceUploader }] = await Promise.all([import('@ethersphere/bee-js'), import('./swarm')])
  const local = {
    upload: async (data: Uint8Array) => (await ChunkSplitter.root(data)).hash().toHex(),
    download: () => Promise.reject(new Error('Only the reference is worked out here')),
  }
  return createEvidenceUploader({ swarm: local, contract, chainId })(box, claimId)
}

export type SealedClient = ReturnType<typeof createSealedDelivery>

export function createSealedDelivery({ address, net = ARC_NET }: { address: Address; net?: SealedNet }) {
  // A contract read every couple of seconds runs into a public node's rate limit, so reads fall over to the next node.
  const transport = net.rpcUrl === ARC_NET.rpcUrl ? fallback(ARC_RPC_URLS.map((url) => http(url))) : http(net.rpcUrl)
  const publicClient = createPublicClient({ chain: net.chain, transport, pollingInterval: net.pollingMs ?? 1000 })
  const usdc = ARC_USDC as Address
  const domain = { name: 'SealedDelivery', version: '1', chainId: net.chain.id, verifyingContract: address } as const
  // Circle Gateway's wallet on this chain, testnet or mainnet. A chain vet402 does not know has none.
  const known = getChain(net.chain.id)
  const gatewayWallet = known
    ? ((getProtocolContractByName('GatewayWallet', known.isTestnet ? 'testnet' : 'mainnet')?.address as Address | undefined) ?? null)
    : null

  const walletOf = (key: Hex) =>
    createWalletClient({ account: privateKeyToAccount(key), chain: net.chain, transport, pollingInterval: net.pollingMs ?? 1000 })

  /** Waits for the transaction and refuses a reverted one. */
  async function mined(hash: Hex): Promise<TransactionReceipt> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS })
    if (receipt.status !== 'success') throw new Error('The transaction reverted')
    return receipt
  }

  /** True when the contract is there. Only a read that answered is kept, so a failed read is tried again. */
  const deployed = new Map<Address, boolean>()
  async function hasCode(at: Address): Promise<boolean> {
    const cached = deployed.get(at)
    if (cached !== undefined) return cached
    const code = await publicClient.getCode({ address: at })
    const found = code !== undefined && code !== '0x'
    deployed.set(at, found)
    return found
  }

  const send = async (
    key: Hex,
    functionName: 'answer' | 'finalize' | 'prove' | 'deposit' | 'withdrawClaimable' | 'claim' | 'flushBurn',
    args: readonly unknown[],
  ): Promise<TransactionReceipt> =>
    mined(
      await walletOf(key).writeContract({
        address,
        abi: SEALED_ABI,
        functionName,
        args,
      } as never),
    )

  const client = {
    address,
    chainId: net.chain.id,

    /** True where Arc's Memo contract is deployed. A local chain has none, and a claim there goes straight to the contract. */
    memoReady: (): Promise<boolean> => hasCode(ARC_MEMO).catch(() => false),
    /** True where Circle Gateway's wallet contract is deployed. */
    gatewayReady: (): Promise<boolean> => (gatewayWallet ? hasCode(gatewayWallet).catch(() => false) : Promise.resolve(false)),

    // Reads.
    coverageFor: (seller: Address, value: bigint) =>
      publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'coverageFor', args: [seller, value] }),
    claimable: (buyer: Address) =>
      publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'claimable', args: [buyer] }),
    deposits: (seller: Address) =>
      publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'deposits', args: [seller] }),
    /** The most one claim's dispute cost can be, in 6-decimal USDC. coverageFor counts it. */
    maxDisputeCost: () => publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'MAX_DISPUTE_COST' }),
    /** What an answer repays the buyer for this claim's gas. */
    gasRefundOf: (claimId: Hex) =>
      publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'gasRefundOf', args: [claimId] }),
    /** What a verdict on this claim takes from the deposit. The buyer is credited half of it. */
    liabilityOf: async (claimId: Hex) =>
      (await publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'claims', args: [claimId] }))[2],
    usdcBalance: (who: Address) =>
      publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    latestBlock: () => publicClient.getBlockNumber(),
    /** The chain's own clock, which is what the contract's deadline is compared with. */
    chainTime: async () => (await publicClient.getBlock()).timestamp,

    /** The key once it is on the chain, and the block it is in. Null while it is not there. */
    async readKeyRevealed(claimId: Hex, fromBlock: bigint): Promise<{ key: Hex; block: bigint; transactionHash: Hex } | null> {
      const logs = await publicClient.getContractEvents({
        address,
        abi: SEALED_ABI,
        eventName: 'KeyRevealed',
        args: { claimId },
        fromBlock,
      })
      const log = logs[0]
      return log?.args.key ? { key: log.args.key, block: log.blockNumber, transactionHash: log.transactionHash } : null
    },

    /**
     * What the answer repaid the buyer for its claim gas, read from the answer's ClaimGasRepaid. Null when there is
     * none, which is also what a contract without that event gives.
     */
    async readClaimGasRepaid(claimId: Hex, fromBlock: bigint): Promise<{ amount: bigint; sent: boolean } | null> {
      const logs = await publicClient.getContractEvents({
        address,
        abi: SEALED_ABI,
        eventName: 'ClaimGasRepaid',
        args: { claimId },
        fromBlock,
      })
      const args = logs[0]?.args
      return args?.amount !== undefined && args.sent !== undefined ? { amount: args.amount, sent: args.sent } : null
    },

    /** Every claim on this contract in the block range. */
    async claimLogs(fromBlock: bigint, toBlock?: bigint) {
      const logs = await publicClient.getLogs({ address, events: CLAIMED_EVENTS, fromBlock, toBlock })
      return logs.flatMap((log) => {
        const { claimId, paymentNonce, seller, deadline } = log.args
        return claimId && paymentNonce && seller && deadline !== undefined
          ? [{ claimId, paymentNonce, seller, deadline, transactionHash: log.transactionHash }]
          : []
      })
    },

    /** Every claim against this seller in the block range. */
    async readClaimed(seller: Address, fromBlock: bigint, toBlock: bigint) {
      const logs = await client.claimLogs(fromBlock, toBlock)
      return logs.filter((log) => log.seller.toLowerCase() === seller.toLowerCase())
    },

    // Promises, which need no chain at all.
    signPromise: (sellerKey: Hex, promise: SealedPromise): Promise<Hex> =>
      privateKeyToAccount(sellerKey).signTypedData({ domain, types: PROMISE_TYPES, primaryType: 'Promise', message: promise }),

    /** True only when the box is what this payment should get: signed by the payee, for this buyer, nonce and price. */
    async checkBox(box: SealedBox, expected: { payTo: string; payer: string; nonce: string; value: bigint }): Promise<boolean> {
      try {
        const promise = boxToPromise(box)
        const signer = await recoverTypedDataAddress({
          domain,
          types: PROMISE_TYPES,
          primaryType: 'Promise',
          message: promise,
          signature: box.sellerSignature,
        })
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
        return (
          same(signer, expected.payTo) &&
          same(promise.seller, expected.payTo) &&
          same(promise.buyer, expected.payer) &&
          same(promise.paymentNonce, expected.nonce) &&
          promise.value === expected.value &&
          same(keccak256(box.ciphertext), promise.ciphertextHash) &&
          promise.expiry > BigInt(Math.floor(Date.now() / 1000))
        )
      } catch {
        return false
      }
    },

    // Writes.
    async claim(buyerKey: Hex, box: SealedBox, auth: PaymentAuth, buyerSignature: Hex) {
      const promise = boxToPromise(box)
      const receipt = await send(buyerKey, 'claim', [promise, box.sellerSignature, auth, buyerSignature])
      const [event] = parseEventLogs({ abi: CLAIMED_EVENTS, logs: receipt.logs })
      if (!event) throw new Error('The claim left no event')
      return {
        claimId: event.args.claimId,
        deadline: event.args.deadline,
        fromBlock: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        transactionHash: receipt.transactionHash,
      }
    },

    /**
     * With links, and where Arc has its Memo contract, the answer goes through Memo, so the seller pays for the memo.
     * The call still comes from the seller's wallet, and the same transaction logs the memo. A memo that cannot be sent
     * leaves a plain answer. Returns the links that went on the chain, or null.
     */
    async answer(sellerKey: Hex, claimId: Hex, key: Hex, links?: ClaimLinks): Promise<ClaimLinks | null> {
      const memo = links && (await client.memoReady()) ? claimMemoOf(claimId, links) : null
      if (memo) {
        let hash: Hex | null = null
        try {
          hash = await walletOf(sellerKey).writeContract({
            address: ARC_MEMO,
            abi: MEMO_ABI,
            functionName: 'memo',
            args: [address, encodeFunctionData({ abi: SEALED_ABI, functionName: 'answer', args: [claimId, key] }), memo.memoId, memo.memoData],
          })
        } catch (error) {
          console.error('answer memo not sent, answering without it:', messageOf(error))
        }
        if (hash) {
          try {
            await mined(hash)
            return links ? cleanLinks(links) : null
          } catch (error) {
            // The key must still reach the chain. A memo transaction that failed on chain falls back to a plain answer.
            console.error('answer memo failed on chain, answering without it:', messageOf(error))
          }
        }
      }
      await send(sellerKey, 'answer', [claimId, key])
      return null
    },

    /**
     * Sends a key the contract will refuse, so the refusal is on the chain for anyone to read.
     * Returns the contract's error name, or null when the contract would take the key.
     * A failure that is not a revert is thrown.
     */
    async tryAnswer(sellerKey: Hex, claimId: Hex, key: Hex): Promise<string | null> {
      let name: string | null = null
      try {
        await publicClient.simulateContract({
          account: privateKeyToAccount(sellerKey),
          address,
          abi: SEALED_ABI,
          functionName: 'answer',
          args: [claimId, key],
        })
      } catch (error) {
        name = revertNameOf(error)
        if (!name) throw error
      }
      if (name) {
        // A set gas limit skips the estimate, which would stop a transaction that will revert.
        const hash = await walletOf(sellerKey).writeContract({
          address,
          abi: SEALED_ABI,
          functionName: 'answer',
          args: [claimId, key],
          gas: REFUSED_ANSWER_GAS,
        } as never)
        await publicClient.waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS })
      }
      return name
    },

    /** Anyone may send it once the deadline has passed. Returns what the buyer was credited. */
    async finalize(key: Hex, claimId: Hex): Promise<bigint> {
      const receipt = await send(key, 'finalize', [claimId])
      const [event] = parseEventLogs({ abi: SEALED_ABI, eventName: 'Silent', logs: receipt.logs })
      if (!event) throw new Error('Finalize left no event')
      return event.args.paidOut
    },

    /** Returns what the buyer was credited. */
    async prove(key: Hex, claimId: Hex, ciphertext: Hex, sealKey: Hex): Promise<bigint> {
      const receipt = await send(key, 'prove', [claimId, ciphertext, sealKey])
      const [event] = parseEventLogs({ abi: SEALED_ABI, eventName: 'Fraud', logs: receipt.logs })
      if (!event) throw new Error('Prove left no event')
      return event.args.paidOut
    },

    /** Moves the credit to the caller. Returns the amount. */
    async withdrawClaimable(key: Hex): Promise<bigint> {
      const receipt = await send(key, 'withdrawClaimable', [])
      const [event] = parseEventLogs({ abi: SEALED_ABI, eventName: 'ClaimableWithdrawn', logs: receipt.logs })
      if (!event) throw new Error('The withdrawal left no event')
      return event.args.amount
    },

    /** Sends the burned half on its way, on a contract that holds it back until asked. */
    async flushBurn(key: Hex): Promise<void> {
      await send(key, 'flushBurn', [])
    },

    /** Approves exactly the amount, then puts it down as the seller's deposit. */
    async deposit(sellerKey: Hex, amount: bigint): Promise<void> {
      await mined(
        await walletOf(sellerKey).writeContract({
          address: usdc,
          abi: erc20Abi,
          functionName: 'approve',
          args: [address, amount],
        }),
      )
      await send(sellerKey, 'deposit', [amount])
    },

    /**
     * Circle Gateway's depositFor: USDC from this wallet becomes the depositor's Gateway balance. Approves exactly the
     * amount first when the allowance is short. Null where there is no Gateway, and nothing is sent.
     */
    async depositToGateway(fromKey: Hex, depositor: Address, amount: bigint): Promise<Hex | null> {
      const gateway = gatewayWallet
      if (amount <= 0n || !gateway || !(await client.gatewayReady())) return null
      const wallet = walletOf(fromKey)
      const allowance = await publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [wallet.account.address, gateway],
      })
      if (allowance < amount) {
        await mined(await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [gateway, amount] }))
      }
      const receipt = await mined(
        await wallet.writeContract({ address: gateway, abi: GATEWAY_WALLET_ABI, functionName: 'depositFor', args: [usdc, depositor, amount] }),
      )
      return receipt.transactionHash
    },

    async transferUsdc(fromKey: Hex, to: Address, amount: bigint): Promise<void> {
      await mined(
        await walletOf(fromKey).writeContract({ address: usdc, abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
      )
    },

    /** What this much gas costs at today's price with no cushion, in 6-decimal USDC, rounded up. */
    async exactGasCost(gas: bigint): Promise<bigint> {
      const price = await publicClient.getGasPrice()
      return (gas * price) / GAS_UNITS_PER_USDC_UNIT + 1n
    },

    /** What this much gas costs at today's price with a cushion, in 6-decimal USDC, rounded up. */
    async gasCost(gas: bigint): Promise<bigint> {
      const price = await publicClient.getGasPrice()
      return (gas * price * FEE_CUSHION) / GAS_UNITS_PER_USDC_UNIT + 1n
    },

    /** Sends only the difference, and only when this wallet cannot pay for the gas itself. */
    async ensureGas(fromKey: Hex, to: Address, gas: bigint): Promise<bigint> {
      const [cost, balance] = await Promise.all([client.gasCost(gas), client.usdcBalance(to)])
      if (balance >= cost) return 0n
      const missing = cost - balance
      await client.transferUsdc(fromKey, to, missing)
      return missing
    },
  }
  return client
}

/**
 * How one seller seals an answer. A lying seller encrypts something else while promising the
 * hash of the real answer, and still holds the right key for what it encrypted.
 */
export function createSealer(client: Pick<SealedClient, 'signPromise'>, sellerKey: Hex, { lie }: { lie?: string } = {}) {
  const seller = privateKeyToAccount(sellerKey).address
  return async function seal(answer: string, payment: { from: string; nonce: string; value: string }) {
    const sealed = sealResponse(lie ?? answer)
    const promised = lie === undefined ? sealed.plaintextHash : sealResponse(answer).plaintextHash
    const promise: SealedPromise = {
      seller,
      value: BigInt(payment.value),
      paymentNonce: payment.nonce as Hex,
      keyHash: sealed.keyHash,
      plaintextHash: promised,
      ciphertextHash: sealed.ciphertextHash,
      expiry: BigInt(Math.floor(Date.now() / 1000) + PROMISE_SECONDS),
      buyer: payment.from as Address,
    }
    const box: SealedBox = {
      ciphertext: sealed.ciphertext,
      promise: { ...promise, value: promise.value.toString(), expiry: promise.expiry.toString() },
      sellerSignature: await client.signPromise(sellerKey, promise),
    }
    return { box, key: sealed.key }
  }
}

export type WatchMode = 'answer' | 'wrong-key'

export interface WatcherOptions {
  client: Pick<SealedClient, 'latestBlock' | 'readClaimed' | 'tryAnswer' | 'chainTime'> & {
    answer(sellerKey: Hex, claimId: Hex, key: Hex, links?: ClaimLinks): Promise<unknown>
  }
  sellerKey: Hex
  /** The key this seller made for a payment nonce, if it knows the payment. */
  keyFor: (nonce: Hex) => Hex | null
  /** 'answer' sends the right key. 'wrong-key' tries a wrong one once and then says nothing more. */
  mode: WatchMode
  onRejected?: (claimId: Hex, errorName: string) => void
  /** What the answer's memo on Arc points to for this payment. Without it, or when it finds nothing, the answer is plain. */
  linksFor?: (nonce: Hex, claimId: Hex) => Promise<ClaimLinks | null>
  log?: (message: string) => void
}

/** A key nobody promised, for the seller that tries to get away with a wrong answer. */
const WRONG_KEY: Hex = `0x${'00'.repeat(32)}`

/**
 * A seller's lookout. Each tick reads new claims and acts on them. A failed read leaves the
 * position where it is, and a failed answer is tried again next tick until the deadline.
 * Nothing it does can throw out of the tick, so a broken RPC never takes the backend down.
 */
export function createSellerWatcher({ client, sellerKey, keyFor, mode, onRejected, linksFor, log = () => {} }: WatcherOptions) {
  const seller = privateKeyToAccount(sellerKey).address
  const pending = new Map<Hex, { nonce: Hex; deadline: bigint }>()
  let next: bigint | null = null
  let ticking = false

  async function readNew() {
    const latest = await client.latestBlock()
    if (next === null) next = latest
    if (latest < next) return
    const claims = await client.readClaimed(seller, next, latest)
    for (const claim of claims) pending.set(claim.claimId, { nonce: claim.paymentNonce, deadline: claim.deadline })
    next = latest + 1n
  }

  async function act(claimId: Hex, item: { nonce: Hex; deadline: bigint }) {
    if ((await client.chainTime()) >= item.deadline) {
      pending.delete(claimId)
      return
    }
    if (mode === 'wrong-key') {
      const name = await client.tryAnswer(sellerKey, claimId, WRONG_KEY)
      if (name) onRejected?.(claimId, name)
      pending.delete(claimId)
      return
    }
    const key = keyFor(item.nonce)
    if (!key) {
      pending.delete(claimId)
      return
    }
    // The links are only pointers. A failure to find them never holds the key back.
    const links = linksFor ? await linksFor(item.nonce, claimId).catch(() => null) : null
    await client.answer(sellerKey, claimId, key, links ?? undefined)
    pending.delete(claimId)
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      await readNew().catch((error: unknown) => log(`watcher read failed: ${messageOf(error)}`))
      for (const [claimId, item] of [...pending]) {
        await act(claimId, item).catch((error: unknown) => log(`watcher answer failed: ${messageOf(error)}`))
      }
    } finally {
      ticking = false
    }
  }

  return {
    tick,
    /** Reads the current position, then watches every `intervalMs` until stopped. */
    start(intervalMs = 4000) {
      void tick()
      const timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
}

/**
 * The links for an answer's memo, read from the file a seller keeps its settled payments in: the Gateway transfer from
 * the PAYMENT-RESPONSE it sent, and the Swarm reference of the evidence box the buyer keeps for this claim, which is the
 * seller's own box with the claim id. A missing file, payment or field gives fewer links, never an error.
 */
export function linksFromSellerStore(file: string, client: Pick<SealedClient, 'address' | 'chainId'>) {
  return async (nonce: Hex, claimId: Hex): Promise<ClaimLinks | null> => {
    if (!existsSync(file)) return null
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { body?: unknown; settledHeader?: unknown }>
    const item = Object.entries(stored).find(([key]) => key.toLowerCase() === nonce.toLowerCase())?.[1]
    return item ? linksOf(item, claimId, client) : null
  }
}

/** The links for an answer's memo from one settled payment: the body the seller sent and its PAYMENT-RESPONSE header. */
export async function linksOf(
  item: { body?: unknown; settledHeader?: unknown },
  claimId: Hex,
  client: Pick<SealedClient, 'address' | 'chainId'>,
): Promise<ClaimLinks | null> {
  const links: ClaimLinks = {}
  try {
    const settled = JSON.parse(Buffer.from(String(item.settledHeader), 'base64').toString('utf8')) as { transaction?: unknown }
    if (typeof settled.transaction === 'string' && settled.transaction) links.gatewayTransferId = settled.transaction
  } catch {
    // No transfer id. The Swarm reference can still go in.
  }
  try {
    const box = (JSON.parse(String(item.body)) as { sealed?: SealedBox }).sealed
    if (box) links.swarmRef = await evidenceRefOf(box, claimId, client.address, client.chainId)
  } catch {
    // No box. The transfer id can still go in.
  }
  return links.gatewayTransferId || links.swarmRef ? links : null
}

/** What Seller F encrypts instead of what it promised. */
const SWAPPED_ANSWER = JSON.stringify({ seller: 'Seller F', answer: 'This is not what the seller promised.' })

/**
 * The sellers that only exist with the contract behind them, Seller A's sealing, and the lookouts.
 * Seller D tries a wrong key and goes quiet, Seller E says nothing at all, and Seller F swaps the
 * answer and then answers the claim honestly. None of them hands the key over a connection.
 */
export function createSealedScene({
  client,
  keys,
  facilitator,
  dropKey,
  storeDir,
  log,
}: {
  client: SealedClient
  keys: { a: Hex; d: Hex; e: Hex; f: Hex }
  facilitator: SellerFacilitator
  /** The switch: Seller A closes the connection when the key is asked for. */
  dropKey: () => boolean
  /** Where the sellers keep their answers and keys, so a restart can still answer an open claim. */
  storeDir?: string
  log?: (message: string) => void
}) {
  const rejected = new Set<string>()
  // Seller A's file is the one the backend gives it in the same folder, data/sellers/seller-a.json.
  const storeFileOf = (name: string) => (storeDir ? path.join(storeDir, `${name.toLowerCase().replace(' ', '-')}.json`) : null)
  const linksOf = (name: string) => {
    const file = storeFileOf(name)
    return file ? { linksFor: linksFromSellerStore(file, client) } : {}
  }
  const quiet = (name: string, key: Hex, lie?: string) =>
    createSeller({
      name,
      payTo: privateKeyToAccount(key).address,
      declaresRecovery: false,
      facilitator,
      confirmCharged: () => Promise.resolve(false),
      dropAfterSettle: () => false,
      ...(storeDir ? { storeFile: storeFileOf(name) as string } : {}),
      sealing: { seal: createSealer(client, key, lie === undefined ? {} : { lie }), handsOverKey: () => false },
    })
  const sellerD = quiet('Seller D', keys.d)
  const sellerE = quiet('Seller E', keys.e)
  const sellerF = quiet('Seller F', keys.f, SWAPPED_ANSWER)
  const sellerASealing: SellerSealing = { seal: createSealer(client, keys.a), handsOverKey: () => !dropKey() }

  /** Seller E has no lookout, because it says nothing. The answers carry a memo on Arc, which the seller pays for. */
  const watchers = (sellerAKeyFor: (nonce: string) => Hex | null) => [
    createSellerWatcher({ client, sellerKey: keys.a, keyFor: sellerAKeyFor, mode: 'answer', log, ...linksOf('Seller A') }),
    createSellerWatcher({ client, sellerKey: keys.f, keyFor: sellerF.keyFor, mode: 'answer', log, ...linksOf('Seller F') }),
    createSellerWatcher({
      client,
      sellerKey: keys.d,
      keyFor: sellerD.keyFor,
      mode: 'wrong-key',
      log,
      onRejected: (claimId, errorName) => {
        if (errorName === 'WrongKey') rejected.add(claimId)
      },
    }),
  ]

  return { sellerD, sellerE, sellerF, sellerASealing, watchers, rejected }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : String(error))

/** What the demo needs from the chain. The fake in the tests and the real one below fill the same shape. */
export interface SealedPorts {
  coverageFor(seller: string, value: bigint): Promise<boolean>
  /** Reads a box from a paid answer. 'plain' is an answer that was not sealed, 'bad' a box that fails the checks. */
  readBox(body: string, payment: PreparedPayment): Promise<{ kind: 'box'; box: SealedBox } | { kind: 'plain' } | { kind: 'bad' }>
  /** Asks for the key with the same payment. A dropped connection comes back as null. */
  requestKey(sellerUrl: string, payment: PreparedPayment): Promise<Hex | null>
  /** Sends the claim from the hold, first adding what it needs from the buyer. */
  claim(box: SealedBox, payment: PreparedPayment): Promise<{ claimId: Hex; deadline: bigint; fromBlock: bigint; transactionHash?: Hex }>
  /** The transaction is there for a link to the explorer. Nothing decides on it. */
  readKey(claimId: Hex, fromBlock: bigint): Promise<{ key: Hex; block: bigint; transactionHash?: Hex } | null>
  /** What the answer repaid the buyer for its claim gas. Null when the answer repaid nothing. Optional, so a fake may leave it out. */
  claimGasRepaid?(claimId: Hex, fromBlock: bigint): Promise<{ amount: bigint; sent: boolean } | null>
  chainTime(): Promise<bigint>
  /** True once this seller's wrong key was refused by the contract. */
  wrongKeyRejected(claimId: Hex): boolean
  finalize(claimId: Hex): Promise<bigint>
  prove(claimId: Hex, ciphertext: Hex, key: Hex): Promise<bigint>
  /** Moves what was credited back to the hold. */
  withdraw(): Promise<bigint>
  /**
   * Counts USDC the hold wallet got back, and once the refunds waiting reach REFUND_TO_GATEWAY_MIN, puts them into
   * the hold's Gateway balance in one Circle Gateway depositFor, so the next payment can spend them. Returns what went
   * back: 0 while they wait in the wallet, or where there is no Gateway. Optional, so a fake may leave it out.
   */
  backToGateway?(amount: bigint): Promise<bigint>
}

/** Refunds wait in the hold wallet until this much has come back, so one deposit's gas is a small part of it. */
export const DEFAULT_REFUND_TO_GATEWAY_MIN = 50_000n

/** REFUND_TO_GATEWAY_MIN in USDC, such as "0.05". A missing or unreadable value gives the default. */
export function parseRefundMin(value: string | undefined): bigint {
  if (!value || !/^\d+(\.\d{1,6})?$/.test(value.trim())) return DEFAULT_REFUND_TO_GATEWAY_MIN
  const [whole, fraction = ''] = value.trim().split('.')
  return BigInt(whole ?? '0') * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

export function createSealedPorts({
  client,
  holdKey,
  buyerKey,
  rejected,
  refundMin = parseRefundMin(process.env.REFUND_TO_GATEWAY_MIN),
}: {
  client: SealedClient
  holdKey: Hex
  buyerKey: Hex
  rejected: ReadonlySet<string>
  /** Refunds go back into Gateway once this much is waiting, in 6-decimal USDC. */
  refundMin?: bigint
}): SealedPorts {
  const hold = privateKeyToAccount(holdKey).address
  const fill = (gas: bigint) => client.ensureGas(buyerKey, hold, gas)
  /** Refunds that came back to the hold wallet and have not gone into Gateway yet. */
  let waiting = 0n
  const DEPOSIT_GAS_ALL = APPROVE_GAS + GATEWAY_DEPOSIT_GAS

  return {
    coverageFor: (seller, value) => client.coverageFor(seller as Address, value),

    async readBox(body, payment) {
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return { kind: 'plain' }
      }
      const box = (parsed as { sealed?: SealedBox } | null)?.sealed
      if (!box) return { kind: 'plain' }
      const good = await client.checkBox(box, {
        payTo: payment.accept.payTo,
        payer: payment.payer,
        nonce: payment.nonce,
        value: payment.amount,
      })
      return good ? { kind: 'box', box } : { kind: 'bad' }
    },

    async requestKey(sellerUrl, payment) {
      try {
        const res = await sendOnce(`${sellerUrl}/key`, {
          method: 'GET',
          headers: { [payment.header.name]: payment.header.value },
        })
        if (!res.ok) return null
        const body = (await res.json()) as { key?: unknown }
        return typeof body.key === 'string' && /^0x[0-9a-fA-F]+$/.test(body.key) ? (body.key as Hex) : null
      } catch {
        return null
      }
    },

    async claim(box, payment) {
      await fill(CLAIM_GAS)
      const { auth, signature } = paymentAuthOf(payment.header.value)
      return client.claim(holdKey, box, auth, signature)
    },

    readKey: (claimId, fromBlock) => client.readKeyRevealed(claimId, fromBlock),
    claimGasRepaid: (claimId, fromBlock) => client.readClaimGasRepaid(claimId, fromBlock),
    chainTime: () => client.chainTime(),
    wrongKeyRejected: (claimId) => rejected.has(claimId),

    async finalize(claimId) {
      await fill(FINALIZE_GAS)
      // The burned half waits in the contract. flushBurn is open to anyone, so the buyer's dispute never pays for it.
      return client.finalize(holdKey, claimId)
    },

    async prove(claimId, ciphertext, key) {
      await fill(PROVE_GAS)
      return client.prove(holdKey, claimId, ciphertext, key)
    },

    async withdraw() {
      // When this credit brings the refunds to the threshold, the gas for the Gateway deposit comes in now, so all of it goes back.
      const deposits =
        (await client.gatewayReady()) && waiting + (await client.claimable(hold).catch(() => 0n)) >= refundMin
      await fill(WITHDRAW_GAS + (deposits ? DEPOSIT_GAS_ALL : 0n))
      return client.withdrawClaimable(holdKey)
    },

    async backToGateway(amount) {
      if (amount <= 0n) return 0n
      waiting += amount
      if (waiting < refundMin || !(await client.gatewayReady())) return 0n
      // The deposit's own gas stays in the wallet. A wallet that holds less than the count, because a new hold sent
      // its loose USDC back to the buyer, sets the count to what is there.
      const [cost, balance] = await Promise.all([client.gasCost(DEPOSIT_GAS_ALL), client.usdcBalance(hold)])
      const there = balance > cost ? balance - cost : 0n
      if (there < waiting) waiting = there
      if (waiting < refundMin) return 0n
      const back = waiting
      if (!(await client.depositToGateway(holdKey, hold, back))) return 0n
      waiting -= back
      return back
    },
  }
}
