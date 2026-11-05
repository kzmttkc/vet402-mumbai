import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { bytesToHex, stringToBytes } from 'viem'
import type { Hex } from 'viem'
import { openResponse, sealResponse } from '../../src/lib/sealed'

const vector = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../contracts/test/fixtures/sealed-vector.json'), 'utf8'),
) as Record<string, string>

describe('the sealing scheme the contract checks', () => {
  test('matches the contract fixture byte for byte', () => {
    const plaintext = vector.plaintext as string
    const bytes = plaintext.startsWith('0x') ? (plaintext as Hex) : bytesToHex(stringToBytes(plaintext))
    const sealed = sealResponse(Buffer.from(bytes.slice(2), 'hex'), vector.key as Hex)
    expect(sealed.ciphertext).toBe(vector.ciphertext as Hex)
    expect(sealed.keyHash).toBe(vector.keyHash as Hex)
    expect(sealed.plaintextHash).toBe(vector.plaintextHash as Hex)
    expect(sealed.ciphertextHash).toBe(vector.ciphertextHash as Hex)
  })

  test('opening with the key gives the plaintext back, and a wrong key does not', () => {
    const sealed = sealResponse('a paid answer')
    expect(Buffer.from(openResponse(sealed.ciphertext, sealed.key)).toString()).toBe('a paid answer')
    const other = sealResponse('x').key
    expect(Buffer.from(openResponse(sealed.ciphertext, other)).toString()).not.toBe('a paid answer')
  })
})
