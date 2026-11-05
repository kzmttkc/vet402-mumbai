import path from 'node:path'
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  recoverTypedDataAddress,
} from 'viem'
import type { Address, Chain, Hex, TransactionReceipt } from 'viem'
import { arcTestnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { ARC_USDC } from '../src/existing/arc-gateway'
import { sealResponse } from '../src/lib/sealed'
import { requireChain } from '../src/onchain-facts'
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
  'event KeyRevealed(bytes32 indexed claimId, bytes32 indexed paymentNonce, bytes key)',
  'event Silent(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)',
  'event Fraud(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)',
  'event ClaimableWithdrawn(address indexed buyer, uint256 amount)',
  'error InvalidSellerSignature()',
  'error InvalidBuyerSignature()',
  'error NotBuyer()',
  'error WrongBuyer()',
  'error WrongPayee()',
  'error WrongValue()',
  'error WrongNonce()',
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
export const ANSWER_GAS = 60_000n
export const APPROVE_GAS = 60_000n
export const DEPOSIT_GAS = 100_000n
export const FINALIZE_GAS = 160_000n
export const WITHDRAW_GAS = 80_000n
/** prove() decrypts in a loop, so its bound leaves room for a small cached answer. */
export const PROVE_GAS = 200_000n
/** Gas prices move, so every estimate keeps a cushion. */
const FEE_CUSHION = 2n
/** Gas is counted in 18 decimals, USDC in 6. */
const GAS_UNITS_PER_USDC_UNIT = 10n ** 12n

const TX_TIMEOUT_MS = 60_000
const REFUSED_ANSWER_GAS = 120_000n
const FLUSH_GAS = 80_000n

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

export type SealedClient = ReturnType<typeof createSealedDelivery>

export function createSealedDelivery({ address, net = ARC_NET }: { address: Address; net?: SealedNet }) {
  const transport = http(net.rpcUrl)
  const publicClient = createPublicClient({ chain: net.chain, transport, pollingInterval: net.pollingMs ?? 1000 })
  const usdc = ARC_USDC as Address
  const domain = { name: 'SealedDelivery', version: '1', chainId: net.chain.id, verifyingContract: address } as const

  const walletOf = (key: Hex) =>
    createWalletClient({ account: privateKeyToAccount(key), chain: net.chain, transport, pollingInterval: net.pollingMs ?? 1000 })

  /** Waits for the transaction and refuses a reverted one. */
  async function mined(hash: Hex): Promise<TransactionReceipt> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS })
    if (receipt.status !== 'success') throw new Error('The transaction reverted')
    return receipt
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

    // Reads.
    coverageFor: (seller: Address, value: bigint) =>
      publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'coverageFor', args: [seller, value] }),
    claimable: (buyer: Address) =>
      publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'claimable', args: [buyer] }),
    deposits: (seller: Address) =>
      publicClient.readContract({ address, abi: SEALED_ABI, functionName: 'deposits', args: [seller] }),
    usdcBalance: (who: Address) =>
      publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    latestBlock: () => publicClient.getBlockNumber(),
    /** The chain's own clock, which is what the contract's deadline is compared with. */
    chainTime: async () => (await publicClient.getBlock()).timestamp,

    /** The key once it is on the chain, and the block it is in. Null while it is not there. */
    async readKeyRevealed(claimId: Hex, fromBlock: bigint): Promise<{ key: Hex; block: bigint } | null> {
      const logs = await publicClient.getContractEvents({
        address,
        abi: SEALED_ABI,
        eventName: 'KeyRevealed',
        args: { claimId },
        fromBlock,
      })
      const log = logs[0]
      return log?.args.key ? { key: log.args.key, block: log.blockNumber } : null
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
      }
    },

    async answer(sellerKey: Hex, claimId: Hex, key: Hex): Promise<void> {
      await send(sellerKey, 'answer', [claimId, key])
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
  client: Pick<SealedClient, 'latestBlock' | 'readClaimed' | 'answer' | 'tryAnswer' | 'chainTime'>
  sellerKey: Hex
  /** The key this seller made for a payment nonce, if it knows the payment. */
  keyFor: (nonce: Hex) => Hex | null
  /** 'answer' sends the right key. 'wrong-key' tries a wrong one once and then says nothing more. */
  mode: WatchMode
  onRejected?: (claimId: Hex, errorName: string) => void
  log?: (message: string) => void
}

/** A key nobody promised, for the seller that tries to get away with a wrong answer. */
const WRONG_KEY: Hex = `0x${'00'.repeat(32)}`

/**
 * A seller's lookout. Each tick reads new claims and acts on them. A failed read leaves the
 * position where it is, and a failed answer is tried again next tick until the deadline.
 * Nothing it does can throw out of the tick, so a broken RPC never takes the backend down.
 */
export function createSellerWatcher({ client, sellerKey, keyFor, mode, onRejected, log = () => {} }: WatcherOptions) {
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
    await client.answer(sellerKey, claimId, key)
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
    start(intervalMs = 2000) {
      void tick()
      const timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
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
  const quiet = (name: string, key: Hex, lie?: string) =>
    createSeller({
      name,
      payTo: privateKeyToAccount(key).address,
      declaresRecovery: false,
      facilitator,
      confirmCharged: () => Promise.resolve(false),
      dropAfterSettle: () => false,
      ...(storeDir ? { storeFile: path.join(storeDir, `${name.toLowerCase().replace(' ', '-')}.json`) } : {}),
      sealing: { seal: createSealer(client, key, lie === undefined ? {} : { lie }), handsOverKey: () => false },
    })
  const sellerD = quiet('Seller D', keys.d)
  const sellerE = quiet('Seller E', keys.e)
  const sellerF = quiet('Seller F', keys.f, SWAPPED_ANSWER)
  const sellerASealing: SellerSealing = { seal: createSealer(client, keys.a), handsOverKey: () => !dropKey() }

  /** Seller E has no lookout, because it says nothing. */
  const watchers = (sellerAKeyFor: (nonce: string) => Hex | null) => [
    createSellerWatcher({ client, sellerKey: keys.a, keyFor: sellerAKeyFor, mode: 'answer', log }),
    createSellerWatcher({ client, sellerKey: keys.f, keyFor: sellerF.keyFor, mode: 'answer', log }),
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
  claim(box: SealedBox, payment: PreparedPayment): Promise<{ claimId: Hex; deadline: bigint; fromBlock: bigint }>
  readKey(claimId: Hex, fromBlock: bigint): Promise<{ key: Hex; block: bigint } | null>
  chainTime(): Promise<bigint>
  /** True once this seller's wrong key was refused by the contract. */
  wrongKeyRejected(claimId: Hex): boolean
  finalize(claimId: Hex): Promise<bigint>
  prove(claimId: Hex, ciphertext: Hex, key: Hex): Promise<bigint>
  /** Moves what was credited back to the hold. */
  withdraw(): Promise<bigint>
}

export function createSealedPorts({
  client,
  holdKey,
  buyerKey,
  rejected,
}: {
  client: SealedClient
  holdKey: Hex
  buyerKey: Hex
  rejected: ReadonlySet<string>
}): SealedPorts {
  const hold = privateKeyToAccount(holdKey).address
  const fill = (gas: bigint) => client.ensureGas(buyerKey, hold, gas)
  // The burned half waits in the contract until someone sends it. A failure here costs the buyer nothing.
  const flushBurned = async () => {
    try {
      await fill(FLUSH_GAS)
      await client.flushBurn(holdKey)
    } catch (error) {
      console.error('could not send the burned half:', error instanceof Error ? error.message.split('\n')[0] : error)
    }
  }

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
    chainTime: () => client.chainTime(),
    wrongKeyRejected: (claimId) => rejected.has(claimId),

    async finalize(claimId) {
      await fill(FINALIZE_GAS)
      const paid = await client.finalize(holdKey, claimId)
      await flushBurned()
      return paid
    },

    async prove(claimId, ciphertext, key) {
      await fill(PROVE_GAS)
      const paid = await client.prove(holdKey, claimId, ciphertext, key)
      await flushBurned()
      return paid
    },

    async withdraw() {
      await fill(WITHDRAW_GAS)
      return client.withdrawClaimable(holdKey)
    },
  }
}
