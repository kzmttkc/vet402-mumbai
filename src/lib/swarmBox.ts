import { Bee, NULL_STAMP, SWARM_GATEWAY_URL } from '@ethersphere/bee-js'
import type { BatchId } from '@ethersphere/bee-js'
import { keccak256 } from 'viem'
import type { Hex } from 'viem'

// The box a buyer holds when it claims, kept on Swarm so anyone can fetch it later.
// It holds the ciphertext only. The key reaches Arc only in a dispute, so the box is useless without it.

/** The public gateway. It stamps uploads with its own batch, so nothing here buys a stamp. */
export const SWARM_GATEWAY = SWARM_GATEWAY_URL

const SWARM_TIMEOUT_MS = 20_000
const REFERENCE = /^[0-9a-f]{64}$/

export interface EvidenceBox {
  ciphertext: Hex
  claimId: Hex
  plaintextHash: Hex
  ciphertextHash: Hex
  contract: string
  chainId: number
}

/** What reaches Swarm: plain bytes. Tests pass a fake, so they never touch the network. */
export interface SwarmWire {
  /** Uploads unencrypted, and returns the 64-character reference. */
  upload(data: Uint8Array): Promise<string>
  download(reference: string): Promise<Uint8Array>
}

/**
 * bee-js against a Bee API. With the gateway the null stamp stands in for a batch the gateway owns.
 * With your own Bee node, pass the postage batch that node bought.
 */
export function createSwarmWire(url: string = SWARM_GATEWAY, timeout = SWARM_TIMEOUT_MS, batchId: BatchId | string = NULL_STAMP): SwarmWire {
  const bee = new Bee(url, { timeout })
  return {
    async upload(data) {
      // No encrypt option: an encrypted reference carries its key, and this one is written to a public entity.
      const result = await bee.data.upload(batchId, data)
      return result.reference.toHex()
    },
    async download(reference) {
      if (!REFERENCE.test(reference)) throw new Error('Not a plain Swarm reference')
      return (await bee.data.download(reference)).toUint8Array()
    },
  }
}

export const encodeBox = (box: EvidenceBox): Uint8Array => new TextEncoder().encode(JSON.stringify(box))

const isHex = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The box, only when it is the one for this claim on this contract and chain, and its
 * ciphertext is the one the seller signed for. Anything else is null.
 */
export function readBox(bytes: Uint8Array, expected: { claimId: string; contract: string; chainId: number }): EvidenceBox | null {
  let parsed: Partial<EvidenceBox> | null
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<EvidenceBox> | null
  } catch {
    return null
  }
  if (!parsed) return null
  const { ciphertext, claimId, plaintextHash, ciphertextHash, contract, chainId } = parsed
  if (!isHex(ciphertext) || !isHex(claimId) || !isHex(plaintextHash) || !isHex(ciphertextHash)) return null
  if (typeof contract !== 'string' || typeof chainId !== 'number') return null
  if (!same(claimId, expected.claimId) || !same(contract, expected.contract) || chainId !== expected.chainId) return null
  if (!same(keccak256(ciphertext), ciphertextHash)) return null
  return { ciphertext, claimId, plaintextHash, ciphertextHash, contract, chainId }
}
