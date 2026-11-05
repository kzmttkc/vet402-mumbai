// A small client for one SealedDelivery deployment on any EVM chain. The chain id and the USDC address
// are read from the node and the contract, so the same code serves Arc, a fork or a local anvil.
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseEventLogs } from 'viem'
import type { Address, Chain, Hex, PublicClient, TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CLAIMED_EVENTS, revertNameOf, SEALED_DELIVERY_ABI } from './common'
import type { PaymentAuth, SealedBox } from './common'
import { boxToPromise } from './common'

export interface ChainOptions {
  /** The SealedDelivery deployment. */
  contract: Address
  /** A JSON-RPC node of the chain the contract is on. */
  rpcUrl: string
  /** How often to poll, in milliseconds. */
  pollingMs?: number
}

const TX_TIMEOUT_MS = 60_000
const REFUSED_ANSWER_GAS = 120_000n

export type SealedChain = ReturnType<typeof createSealedChain>

export function createSealedChain({ contract, rpcUrl, pollingMs = 1000 }: ChainOptions) {
  const transport = http(rpcUrl)
  const pub: PublicClient = createPublicClient({ transport, pollingInterval: pollingMs })
  let chainPromise: Promise<Chain> | null = null
  const chain = () =>
    (chainPromise ??= pub.getChainId().then((id) =>
      defineChain({
        id,
        name: `chain ${id}`,
        nativeCurrency: { name: 'native', symbol: 'GAS', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      }),
    ))
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address: contract, abi: SEALED_DELIVERY_ABI, functionName, args } as never) as Promise<T>

  async function wallet(key: Hex) {
    return createWalletClient({ account: privateKeyToAccount(key), chain: await chain(), transport, pollingInterval: pollingMs })
  }
  async function mined(hash: Hex): Promise<TransactionReceipt> {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS })
    if (receipt.status !== 'success') throw new Error('The transaction reverted')
    return receipt
  }
  async function send(key: Hex, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    const w = await wallet(key)
    return mined(await w.writeContract({ address: contract, abi: SEALED_DELIVERY_ABI, functionName, args } as never))
  }

  const client = {
    contract,
    chainId: async () => (await chain()).id,

    // Reads.
    coverageFor: (seller: Address, value: bigint) => read<boolean>('coverageFor', [seller, value]),
    coverage: (seller: Address) => read<bigint>('coverage', [seller]),
    deposits: (seller: Address) => read<bigint>('deposits', [seller]),
    claimable: (buyer: Address) => read<bigint>('claimable', [buyer]),
    usdc: () => read<Address>('USDC'),
    disputeCost: () => read<bigint>('DISPUTE_COST'),
    latestBlock: () => pub.getBlockNumber(),
    chainTime: async () => (await pub.getBlock()).timestamp,

    async readKeyRevealed(claimId: Hex, fromBlock: bigint): Promise<{ key: Hex; block: bigint } | null> {
      const logs = await pub.getContractEvents({
        address: contract,
        abi: SEALED_DELIVERY_ABI,
        eventName: 'KeyRevealed',
        args: { claimId },
        fromBlock,
      })
      const log = logs[0] as { args: { key?: Hex }; blockNumber: bigint } | undefined
      return log?.args.key ? { key: log.args.key, block: log.blockNumber } : null
    },

    async readClaimed(seller: Address, fromBlock: bigint, toBlock: bigint) {
      const logs = await pub.getLogs({ address: contract, events: CLAIMED_EVENTS, fromBlock, toBlock })
      return logs.flatMap((log) => {
        const { claimId, paymentNonce, seller: who, deadline } = log.args
        return claimId && paymentNonce && who && deadline !== undefined && who.toLowerCase() === seller.toLowerCase()
          ? [{ claimId, paymentNonce, seller: who, deadline, transactionHash: log.transactionHash }]
          : []
      })
    },

    // Writes. Each key pays its own gas on this chain.
    async claim(buyerKey: Hex, box: SealedBox, auth: PaymentAuth, buyerSignature: Hex) {
      const receipt = await send(buyerKey, 'claim', [boxToPromise(box), box.sellerSignature, auth, buyerSignature])
      const [event] = parseEventLogs({ abi: CLAIMED_EVENTS, logs: receipt.logs })
      if (!event) throw new Error('The claim left no event')
      return { claimId: event.args.claimId as Hex, deadline: event.args.deadline as bigint, fromBlock: receipt.blockNumber }
    },
    answer: async (sellerKey: Hex, claimId: Hex, key: Hex) => {
      await send(sellerKey, 'answer', [claimId, key])
    },
    /** Sends a key the contract refuses, so the refusal is on chain. Null when the contract would take it. */
    async tryAnswer(sellerKey: Hex, claimId: Hex, key: Hex): Promise<string | null> {
      try {
        await pub.simulateContract({
          account: privateKeyToAccount(sellerKey),
          address: contract,
          abi: SEALED_DELIVERY_ABI,
          functionName: 'answer',
          args: [claimId, key],
        } as never)
        return null
      } catch (error) {
        const name = revertNameOf(error)
        if (!name) throw error
        const w = await wallet(sellerKey)
        const hash = await w.writeContract({
          address: contract,
          abi: SEALED_DELIVERY_ABI,
          functionName: 'answer',
          args: [claimId, key],
          gas: REFUSED_ANSWER_GAS,
        } as never)
        await pub.waitForTransactionReceipt({ hash, timeout: TX_TIMEOUT_MS })
        return name
      }
    },
    async finalize(key: Hex, claimId: Hex): Promise<bigint> {
      const receipt = await send(key, 'finalize', [claimId])
      const [event] = parseEventLogs({ abi: SEALED_DELIVERY_ABI, eventName: 'Silent', logs: receipt.logs })
      if (!event) throw new Error('Finalize left no event')
      return (event.args as { paidOut: bigint }).paidOut
    },
    async prove(key: Hex, claimId: Hex, ciphertext: Hex, sealKey: Hex): Promise<bigint> {
      const receipt = await send(key, 'prove', [claimId, ciphertext, sealKey])
      const [event] = parseEventLogs({ abi: SEALED_DELIVERY_ABI, eventName: 'Fraud', logs: receipt.logs })
      if (!event) throw new Error('Prove left no event')
      return (event.args as { paidOut: bigint }).paidOut
    },
    async withdrawClaimable(key: Hex): Promise<bigint> {
      const receipt = await send(key, 'withdrawClaimable', [])
      const [event] = parseEventLogs({ abi: SEALED_DELIVERY_ABI, eventName: 'ClaimableWithdrawn', logs: receipt.logs })
      if (!event) throw new Error('The withdrawal left no event')
      return (event.args as { amount: bigint }).amount
    },
    /** Approves exactly the amount of the contract's own USDC, then deposits it for the seller. */
    async deposit(sellerKey: Hex, amount: bigint): Promise<void> {
      const usdc = await client.usdc()
      const w = await wallet(sellerKey)
      await mined(await w.writeContract({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [contract, amount] }))
      await send(sellerKey, 'deposit', [amount])
    },
  }
  return client
}
