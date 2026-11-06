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
  /**
   * Your own Bee node only: pins the box on that node and returns when the postage batch that stamped
   * it runs out, in Unix seconds. The public gateway's batch is the gateway's own, so its wire has no keep.
   */
  keep?(reference: string): Promise<number | null>
}

/**
 * When each box from vet402's own Bee node stays on Swarm until, in Unix seconds, by reference. The
 * upload fills it, and the Arkiv sink copies it to the box's evidence entity, so the published screen
 * can read it from Arkiv.
 */
export const swarmKeptUntil = new Map<string, number>()

/** The parts of bee-js the wire uses. Tests pass a fake. */
export type BeeApi = Pick<Bee, 'data' | 'pin' | 'stamp'>

const isNullStamp = (batchId: BatchId | string) =>
  (typeof batchId === 'string' ? batchId : batchId.toHex()).replace(/^0x/, '') === NULL_STAMP.toHex()

/**
 * bee-js against a Bee API. With the gateway the null stamp stands in for a batch the gateway owns.
 * With your own Bee node, pass the postage batch that node bought: each box is then pinned on the
 * node, and the batch's time to live says how long it stays.
 */
export function createSwarmWire(
  url: string = SWARM_GATEWAY,
  timeout = SWARM_TIMEOUT_MS,
  batchId: BatchId | string = NULL_STAMP,
  { bee = new Bee(url, { timeout }), now = Date.now }: { bee?: BeeApi; now?: () => number } = {},
): SwarmWire {
  const own = !isNullStamp(batchId)

  async function keep(reference: string): Promise<number | null> {
    await bee.pin.add(reference)
    // The batch's TTL is Bee's estimate at today's storage price, counted from now.
    const seconds = (await bee.stamp.get(batchId)).duration.toSeconds()
    return seconds > 0 ? Math.floor(now() / 1000) + Math.floor(seconds) : null
  }

  return {
    async upload(data) {
      // No encrypt option: an encrypted reference carries its key, and this one is written to a public entity.
      const result = await bee.data.upload(batchId, data)
      const reference = result.reference.toHex()
      if (own) {
        // The box is on Swarm either way. A failed pin or batch read only leaves the date out.
        const until = await keep(reference).catch(() => null)
        if (until) swarmKeptUntil.set(reference, until)
      }
      return reference
    },
    async download(reference) {
      if (!REFERENCE.test(reference)) throw new Error('Not a plain Swarm reference')
      return (await bee.data.download(reference)).toUint8Array()
    },
    ...(own ? { keep } : {}),
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
