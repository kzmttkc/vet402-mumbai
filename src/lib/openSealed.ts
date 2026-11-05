import { decodeAbiParameters, keccak256, stringToBytes } from 'viem'
import type { Hex } from 'viem'
import { openResponse } from './sealed'

/** The public node. The published screen reads the key from it directly, with no backend in between. */
export const PUBLIC_RPC = 'https://rpc.testnet.arc.io'

export const MATCHES_PROMISE = "Matches the seller's promise."
export const DOES_NOT_MATCH_PROMISE = "Does not match the seller's promise."
export const COULD_NOT_READ_KEY = 'Could not read the key.'

const KEY_REVEALED_TOPIC = keccak256(stringToBytes('KeyRevealed(bytes32,bytes32,bytes)'))
const READ_TIMEOUT_MS = 10_000

/** One row of the exported file. The key is not in it: it is read from the chain. */
export interface PublicSealedAnswer {
  ref: string
  sellerName: string
  ciphertext: string
  claimId: string
  plaintextHash: string
  /** The block that holds the key, as a decimal string, so the read asks for one block only. */
  keyBlock: string
}

export interface PublicSealedFile {
  /** The contract, so the read can only find a key this contract accepted. */
  contract: string | null
  answers: PublicSealedAnswer[]
}

export type OpenResult =
  | { ok: true; text: string; line: string; matches: boolean }
  | { ok: false; line: string }

/** Reads the key straight from a node. Null when the block holds no key for this claim. */
export async function readKeyFromNode(
  { rpcUrl, contract, claimId, keyBlock }: { rpcUrl: string; contract: string; claimId: string; keyBlock: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Hex | null> {
  const block = `0x${BigInt(keyBlock).toString(16)}`
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{ address: contract, fromBlock: block, toBlock: block, topics: [KEY_REVEALED_TOPIC, claimId] }],
    }),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`The node answered ${res.status}`)
  const body = (await res.json()) as { result?: { data?: Hex }[]; error?: unknown }
  if (body.error || !Array.isArray(body.result)) throw new Error('The node refused the read')
  const data = body.result[0]?.data
  if (!data) return null
  return decodeAbiParameters([{ type: 'bytes' }], data)[0]
}

/** Reads the key from the chain, opens the answer here, and compares it with the promise. */
export async function openSealedAnswer(
  answer: PublicSealedAnswer,
  contract: string,
  { rpcUrl = PUBLIC_RPC, fetchImpl = fetch }: { rpcUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<OpenResult> {
  try {
    const key = await readKeyFromNode({ rpcUrl, contract, claimId: answer.claimId, keyBlock: answer.keyBlock }, fetchImpl)
    if (!key) return { ok: false, line: COULD_NOT_READ_KEY }
    const plain = openResponse(answer.ciphertext as Hex, key)
    const matches = keccak256(plain) === answer.plaintextHash
    return { ok: true, text: new TextDecoder().decode(plain), matches, line: matches ? MATCHES_PROMISE : DOES_NOT_MATCH_PROMISE }
  } catch {
    return { ok: false, line: COULD_NOT_READ_KEY }
  }
}
