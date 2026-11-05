import { bytesToHex, encodePacked, hexToBytes, keccak256, stringToBytes } from 'viem'
import type { Hex } from 'viem'

// The sealing scheme that SealedDelivery.prove() checks onchain.
//
// For block i = 0, 1, 2, ... the keystream block is keccak256(abi.encodePacked(key, uint256(i))).
// Each 32-byte chunk of the data is XORed with its keystream block, and the last chunk is
// truncated to the data length. Sealing and opening are the same operation.

const BLOCK_BYTES = 32

export interface SealedResponse {
  /** The decryption key. The seller hands it over on a separate request. */
  key: Hex
  /** The encrypted response, sent together with the signed Promise. */
  ciphertext: Hex
  /** keccak256(abi.encodePacked(key)), the promise's keyHash. */
  keyHash: Hex
  /** keccak256(plaintext), the promise's plaintextHash. */
  plaintextHash: Hex
  /** keccak256(ciphertext), the promise's ciphertextHash. */
  ciphertextHash: Hex
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? stringToBytes(data) : data
}

function randomKey(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(BLOCK_BYTES)))
}

function keystreamBlock(key: Hex, index: number): Uint8Array {
  return hexToBytes(keccak256(encodePacked(['bytes', 'uint256'], [key, BigInt(index)])))
}

function applyKeystream(data: Uint8Array, key: Hex): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let start = 0; start < data.length; start += BLOCK_BYTES) {
    const stream = keystreamBlock(key, start / BLOCK_BYTES)
    const end = Math.min(start + BLOCK_BYTES, data.length)
    for (let i = start; i < end; i++) out[i] = data[i]! ^ stream[i - start]!
  }
  return out
}

/** Encrypts a response. Pass a key to get a repeatable result; by default a fresh random key is used. */
export function sealResponse(plaintext: string | Uint8Array, key: Hex = randomKey()): SealedResponse {
  const bytes = toBytes(plaintext)
  const ciphertext = bytesToHex(applyKeystream(bytes, key))
  return {
    key,
    ciphertext,
    keyHash: keccak256(key),
    plaintextHash: keccak256(bytes),
    ciphertextHash: keccak256(ciphertext),
  }
}

/** Decrypts a response with the key the seller revealed. */
export function openResponse(ciphertext: Hex | Uint8Array, key: Hex): Uint8Array {
  const bytes = typeof ciphertext === 'string' ? hexToBytes(ciphertext) : ciphertext
  return applyKeystream(bytes, key)
}
