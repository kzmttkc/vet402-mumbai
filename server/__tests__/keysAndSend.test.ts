import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import type { Server } from 'node:net'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { loadKeys } from '../keys'
import { sendOnce } from '../sendOnce'

// Files are only written inside a fresh temporary folder, and the keys live in a plain object,
// so the real environment and the app's .env are never read or written.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'keys-test-'))
  expect(realpathSync(dir).startsWith(realpathSync(os.tmpdir()))).toBe(true)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Keys', () => {
  test('makes five different keys, and the hold key is never a seller', () => {
    const env: Record<string, string | undefined> = {}
    const keys = loadKeys(env, path.join(dir, '.env'))

    const addresses = Object.values(keys).map((k) => privateKeyToAccount(k).address)
    expect(new Set(addresses).size).toBe(5)
    expect(keys.hold).not.toBe(keys.sellerA)
    expect(keys.hold).not.toBe(keys.sellerB)
    expect(readdirSync(dir)).toEqual(['.env'])
    expect(process.env.SELLER_A_PRIVATE_KEY).toBeUndefined()
  })

  test('keeps the same keys on the next start', () => {
    const file = path.join(dir, '.env')
    const first = loadKeys({}, file)
    const second = loadKeys({}, file)
    expect(second).toEqual(first)
    expect(readFileSync(file, 'utf8').match(/PRIVATE_KEY=/g)).toHaveLength(5)
  })

  test('refuses to start if the hold key is also a seller', () => {
    const first = loadKeys({}, path.join(dir, '.env'))
    const env = {
      BUYER_PRIVATE_KEY: first.buyer,
      HOLD_PRIVATE_KEY: first.hold,
      SELLER_A_PRIVATE_KEY: first.hold,
      SELLER_B_PRIVATE_KEY: first.sellerB,
    }
    expect(() => loadKeys(env, path.join(dir, 'other.env'))).toThrow('hold key is never a seller')
  })
})

describe('The HTTP function for paid requests', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.close()
  })

  test('sends once and does not retry when the connection drops', async () => {
    let connections = 0
    let requests = 0
    const server = net.createServer((socket) => {
      connections++
      socket.on('data', () => {
        requests++
        socket.destroy()
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo

    await expect(sendOnce(`http://127.0.0.1:${port}/x`, { method: 'GET', headers: { 'Payment-Signature': 'abc' } })).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(requests).toBe(1)
    expect(connections).toBe(1)
  })

  test('asks for a fresh connection and refuses redirects', async () => {
    let seen: RequestInit | undefined
    const fakeFetch = ((_url: string, init?: RequestInit) => {
      seen = init
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch

    await sendOnce('https://example.com/x', { method: 'GET' }, fakeFetch)

    expect(seen?.keepalive).toBe(false)
    expect(seen?.redirect).toBe('error')
    expect((seen?.headers as Record<string, string>).Connection).toBe('close')
  })
})
