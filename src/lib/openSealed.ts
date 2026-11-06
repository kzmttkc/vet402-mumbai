import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToBytes } from 'viem'
import type { Hex } from 'viem'
import { openResponse } from './sealed'
import { readBox } from './swarmBox'

/** The public node. The published screen reads the key from it directly, with no backend in between. */
export const PUBLIC_RPC = 'https://rpc.testnet.arc.network'

export const MATCHES_PROMISE = "Matches the seller's promise."
export const DOES_NOT_MATCH_PROMISE = "Does not match the seller's promise."
export const COULD_NOT_READ_KEY = 'Could not read the key.'

const KEY_REVEALED_TOPIC = keccak256(stringToBytes('KeyRevealed(bytes32,bytes32,bytes)'))
const READ_TIMEOUT_MS = 10_000

/**
 * One row of the exported file: which claim, and where its key is. The box is not in it, and neither
 * is the key. The box comes from Swarm through the reference on Arkiv, and the key from Arc.
 */
export interface PublicSealedAnswer {
  ref: string
  sellerName: string
  claimId: string
  /** The block that holds the key, as a decimal string, so the read asks for one block only. */
  keyBlock: string
}

/** A claim with its box in hand: from Swarm on the published screen, or from the try's own run. */
export interface SealedBoxToOpen extends PublicSealedAnswer {
  ciphertext: string
}

export interface PublicSealedFile {
  /** The contract, so the read can only find a key this contract accepted. */
  contract: string | null
  answers: PublicSealedAnswer[]
}

export type OpenResult =
  | { ok: true; text: string; line: string; matches: boolean; read?: string[] }
  | { ok: false; line: string; read?: string[] }

/** The chain the contract lives on. A box made for another chain is not used. */
export const ARC_TESTNET_ID = 5042002

export const FROM_ARKIV = 'Record from Arkiv.'
export const FROM_SWARM = 'Box from Swarm.'
export const BOX_NOT_THIS_CLAIM = 'This box is not the one claimed on Arc.'
export const FROM_ARC = 'Key from Arc.'
export const NO_ARKIV_RECORD = 'No record on Arkiv for this claim.'
export const COULD_NOT_READ_ARKIV_RECORD = 'Could not read Arkiv.'
export const BOX_NOT_FOUND = 'Box not found on Swarm.'

/** How the published screen reaches Arkiv and Swarm. Without either, nothing opens: there is no copy to fall back on. */
export interface EvidenceSources {
  readEvidence?: (claimId: string) => Promise<string | null>
  downloadBox?: (reference: string) => Promise<Uint8Array>
}

/** One `vet402_evidence` entity: a claim and the plain Swarm reference of its box. */
export interface EvidenceEntry {
  claimId: string
  swarmRef: string
}

/**
 * What the screen offers to open: the claims that have a `vet402_evidence` entity on Arkiv, in the
 * order Arkiv returned them. The exported file only adds the seller's name and the key's block.
 */
export function openableAnswers(file: PublicSealedFile, evidence: readonly EvidenceEntry[]): PublicSealedAnswer[] {
  const byClaim = new Map(file.answers.map((answer) => [answer.claimId.toLowerCase(), answer]))
  const seen = new Set<string>()
  return evidence.flatMap(({ claimId }) => {
    const id = claimId.toLowerCase()
    const answer = byClaim.get(id)
    if (!answer || seen.has(id)) return []
    seen.add(id)
    return [answer]
  })
}

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

/** The hashes the contract stored at claim time. The box is judged against these, not against the box itself. */
export async function readClaimHashes(
  { rpcUrl, contract, claimId }: { rpcUrl: string; contract: string; claimId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ plaintextHash: Hex; ciphertextHash: Hex } | null> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: contract, data: encodeFunctionData({ abi: CLAIMS_ABI, functionName: 'claims', args: [claimId as Hex] }) }, 'latest'],
    }),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`The node answered ${res.status}`)
  const body = (await res.json()) as { result?: Hex; error?: unknown }
  if (body.error || typeof body.result !== 'string') throw new Error('The node refused the read')
  const fields = decodeFunctionResult({ abi: CLAIMS_ABI, functionName: 'claims', data: body.result }) as readonly unknown[]
  const [, , , , , , , plaintextHash, ciphertextHash] = fields as [unknown, unknown, unknown, unknown, unknown, unknown, unknown, Hex, Hex]
  if (/^0x0+$/.test(plaintextHash)) return null
  return { plaintextHash, ciphertextHash }
}

export const CLAIMS_ABI = parseAbi([
  'function claims(bytes32) view returns (address seller, address buyer, uint256 liability, uint64 deadline, bytes32 keyHash, uint8 status, bytes32 paymentNonce, bytes32 plaintextHash, bytes32 ciphertextHash)',
])

/** Reads the key from the chain, opens the answer here, and compares it with the promise. */
export async function openSealedAnswer(
  answer: SealedBoxToOpen,
  contract: string,
  { rpcUrl = PUBLIC_RPC, fetchImpl = fetch }: { rpcUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<OpenResult> {
  try {
    const key = await readKeyFromNode({ rpcUrl, contract, claimId: answer.claimId, keyBlock: answer.keyBlock }, fetchImpl)
    // The box may come from anywhere, so the contract's own record decides what counts as the promise.
    const onChain = await readClaimHashes({ rpcUrl, contract, claimId: answer.claimId }, fetchImpl)
    if (!onChain || keccak256(answer.ciphertext as Hex) !== onChain.ciphertextHash) return { ok: false, line: BOX_NOT_THIS_CLAIM }
    if (!key) return { ok: false, line: COULD_NOT_READ_KEY }
    const plain = openResponse(answer.ciphertext as Hex, key)
    const matches = keccak256(plain) === onChain.plaintextHash
    return { ok: true, text: new TextDecoder().decode(plain), matches, line: matches ? MATCHES_PROMISE : DOES_NOT_MATCH_PROMISE }
  } catch {
    return { ok: false, line: COULD_NOT_READ_KEY }
  }
}

/**
 * Opens the answer from the public record only. The Swarm reference comes from Arkiv, the box from
 * Swarm and the key from Arc. There is no copy on the page: when Arkiv or Swarm cannot be read, the
 * answer does not open, and the line says which one failed. `read` names each source that answered.
 */
export async function openFromRecord(
  answer: PublicSealedAnswer,
  contract: string,
  sources: EvidenceSources,
  options: { rpcUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<OpenResult> {
  const read: string[] = []
  if (!sources.readEvidence || !sources.downloadBox) return { ok: false, line: COULD_NOT_READ_ARKIV_RECORD, read }

  let reference: string | null
  try {
    reference = await sources.readEvidence(answer.claimId)
  } catch {
    return { ok: false, line: COULD_NOT_READ_ARKIV_RECORD, read }
  }
  if (!reference) return { ok: false, line: NO_ARKIV_RECORD, read }
  read.push(FROM_ARKIV)

  let bytes: Uint8Array
  try {
    bytes = await sources.downloadBox(reference)
  } catch {
    return { ok: false, line: BOX_NOT_FOUND, read }
  }
  const box = readBox(bytes, { claimId: answer.claimId, contract, chainId: ARC_TESTNET_ID })
  if (!box) return { ok: false, line: BOX_NOT_THIS_CLAIM, read }
  read.push(FROM_SWARM)

  const result = await openSealedAnswer({ ...answer, ciphertext: box.ciphertext }, contract, options)
  if (result.ok) read.push(FROM_ARC)
  return { ...result, read }
}
