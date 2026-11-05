import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeAbiParameters } from 'viem'
import { exportPublic } from '../../scripts/export-public'
import { OpenSealed } from '../../src/components/OpenSealed'
import { DemoCard } from '../../src/components/DemoCard'
import type { DemoRun } from '../../src/hooks/useDemo'
import { DOES_NOT_MATCH_PROMISE, MATCHES_PROMISE, openSealedAnswer, PUBLIC_RPC } from '../../src/lib/openSealed'
import type { PublicSealedAnswer } from '../../src/lib/openSealed'
import { loadSealedFile, STATIC_PATHS } from '../../src/lib/publicData'
import { sealResponse } from '../../src/lib/sealed'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).__ARKIV_WRITER__ = ''
})

const CONTRACT = `0x${'c1'.repeat(20)}`
const CLAIM = `0x${'c2'.repeat(32)}`
const TEXT = '{"answer":"Here is the answer you paid for."}'
const sealed = sealResponse(TEXT)
const answer: PublicSealedAnswer = {
  ref: 'r0',
  sellerName: 'Seller A',
  ciphertext: sealed.ciphertext,
  claimId: CLAIM,
  plaintextHash: sealed.plaintextHash,
  keyBlock: '255',
}

const node = (result: unknown, status = 200) => {
  const calls: { url: string; body: { method: string; params: [Record<string, unknown>] } }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) })
    return new Response(JSON.stringify({ result }), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}
const log = (key: `0x${string}`) => [{ data: encodeAbiParameters([{ type: 'bytes' }], [key]) }]

describe('opening a sealed answer in the browser', () => {
  test('reads one block of the contract for this claim from the public node, and the answer matches', async () => {
    const { fetchImpl, calls } = node(log(sealed.key))
    const result = await openSealedAnswer(answer, CONTRACT, { fetchImpl })
    expect(result).toEqual({ ok: true, text: TEXT, matches: true, line: MATCHES_PROMISE })
    expect(MATCHES_PROMISE).toBe("Matches the seller's promise.")
    expect(calls[0]?.url).toBe(PUBLIC_RPC)
    expect(calls[0]?.url).toBe('https://rpc.testnet.arc.network')
    expect(calls[0]?.body.method).toBe('eth_getLogs')
    expect(calls[0]?.body.params[0]).toMatchObject({ address: CONTRACT, fromBlock: '0xff', toBlock: '0xff' })
    expect((calls[0]?.body.params[0].topics as string[])[1]).toBe(CLAIM)
  })

  test('another plaintext does not match', async () => {
    const other = sealResponse('something else')
    const { fetchImpl } = node(log(other.key))
    const result = await openSealedAnswer({ ...answer, ciphertext: other.ciphertext }, CONTRACT, { fetchImpl })
    expect(result).toMatchObject({ ok: true, matches: false, line: DOES_NOT_MATCH_PROMISE })
  })

  test('no key, a refusing node or no network all end in the same plain sentence', async () => {
    expect(await openSealedAnswer(answer, CONTRACT, { fetchImpl: node([]).fetchImpl })).toEqual({ ok: false, line: 'Could not read the key.' })
    expect(await openSealedAnswer(answer, CONTRACT, { fetchImpl: node(null, 500).fetchImpl })).toEqual({ ok: false, line: 'Could not read the key.' })
    const down = (() => Promise.reject(new Error('blocked'))) as unknown as typeof fetch
    expect(await openSealedAnswer(answer, CONTRACT, { fetchImpl: down })).toEqual({ ok: false, line: 'Could not read the key.' })
  })

  test('no exported file means nothing to open', async () => {
    const page = (() => Promise.resolve(new Response('<!doctype html>'))) as unknown as typeof fetch
    expect(await loadSealedFile(page)).toEqual({ contract: null, answers: [] })
    expect(STATIC_PATHS.sealed).toBe('/static/sealed.json')
  })
})

describe('what the screens say', () => {
  const banned = /wallet|\bgas\b|signature|\barc\b|ethereum|\bbase\b|polygon|solana|0x[0-9a-f]{40}(?![0-9a-f])/i
  const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

  test('the sealed panel has its title, no way to pay, and none of the banned words', () => {
    const html = renderToStaticMarkup(<OpenSealed />)
    expect(html).toContain('Open a sealed answer')
    expect(textOf(html)).not.toMatch(banned)
    expect(textOf(html)).not.toMatch(/pay/i)
  })

  test('the demo card shows the new steps with seconds, and none of the banned words', () => {
    const run: DemoRun = {
      id: 'x',
      kind: 'f',
      state: 'done',
      error: null,
      action: 'prove',
      steps: [
        { name: 'claim', atMs: 1000 },
        { name: 'key on chain', atMs: 2000 },
        { name: 'opened', atMs: 2500 },
      ],
    }
    const text = textOf(
      renderToStaticMarkup(<DemoCard run={run} error={null} running={false} start={async () => {}} sealed act={async () => {}} acting={false} />),
    )
    expect(text).toContain('Claim 1.0 s')
    expect(text).toContain('Key on chain 2.0 s')
    expect(text).toContain('Opened 2.5 s')
    expect(text).toContain('Prove')
    expect(text).toContain('Try Seller F')
    expect(text).not.toMatch(banned)
  })

  test('without the contract the card offers Sellers A and B only', () => {
    const html = renderToStaticMarkup(<DemoCard run={null} error={null} running={false} start={async () => {}} sealed={false} act={async () => {}} acting={false} />)
    expect(html).toContain('Try Seller A')
    expect(html).not.toContain('Try Seller D')
  })
})

describe('the export of sealed answers', () => {
  const dirs: string[] = []
  const tempDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'export-sealed-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'local',
    at: '2026-11-06T00:00:00.000Z',
    amount: '1000',
    sellerName: 'Seller A',
    responseHash: 'f'.repeat(64),
    responseBytes: 42,
    timesReceived: 1,
    transferId: 't',
    nonce: `0x${'a'.repeat(64)}`,
    status: 'received',
    batchTx: null,
    ...over,
  })
  const SEALED = { ciphertext: sealed.ciphertext, claimId: CLAIM, plaintextHash: sealed.plaintextHash, keyBlock: '255' }
  const run = (rows: unknown[], sealedContract: string | null = CONTRACT) => {
    const dataDir = tempDir()
    const outDir = tempDir()
    writeFileSync(path.join(dataDir, 'receipts.json'), JSON.stringify(rows))
    exportPublic({ dataDir, outDir, sealedContract })
    return JSON.parse(readFileSync(path.join(outDir, 'sealed.json'), 'utf8')) as { contract: string | null; answers: Record<string, unknown>[] }
  }

  test('writes the named fields only, and rows with no key on the chain stay out', () => {
    const file = run([row({ sealed: SEALED, key: sealed.key }), row()])
    expect(file.contract).toBe(CONTRACT)
    expect(file.answers).toEqual([{ ref: 'r0', sellerName: 'Seller A', ...SEALED }])
    expect(JSON.stringify(file)).not.toContain(sealed.key)
  })

  test('no contract address still writes a file the screen can read', () => {
    expect(run([row()], null)).toEqual({ contract: null, answers: [] })
  })

  test('a malformed sealed row stops the export before anything is written', () => {
    const dataDir = tempDir()
    const outDir = tempDir()
    writeFileSync(path.join(dataDir, 'receipts.json'), JSON.stringify([row({ sealed: { ...SEALED, claimId: 'nope' } })]))
    expect(() => exportPublic({ dataDir, outDir })).toThrow('malformed')
    expect(existsSync(path.join(outDir, 'sealed.json'))).toBe(false)
  })

  test('an address in a sealed answer stops the export', () => {
    const dataDir = tempDir()
    const outDir = tempDir()
    writeFileSync(path.join(dataDir, 'receipts.json'), JSON.stringify([row({ sealed: { ...SEALED, ciphertext: `0x${'ab'.repeat(20)}` } })]))
    expect(() => exportPublic({ dataDir, outDir, sealedContract: CONTRACT })).toThrow('would hold an address')
  })
})
