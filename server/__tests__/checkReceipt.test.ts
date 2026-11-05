import { describe, expect, test } from 'bun:test'
import { custom } from 'viem'
import { createArkivCounter } from '../../src/arkiv/readArkiv'
import {
  ARKIV_NOT_USED,
  CIRCLE_PRODUCTION,
  CIRCLE_TESTNET,
  COULD_NOT_READ_ARKIV,
  COULD_NOT_READ_CIRCLE,
  PRE_EVENT_NONCE,
  amountLine,
  arkivLine,
  checkReceipt,
  circleHostFor,
  circleLine,
  readCircle,
} from '../../src/lib/checkReceipt'

const EVENT_NONCE = `0x${'e'.repeat(64)}`
const WRITER = '0x00000000000000000000000000000000000000aa'

const answering = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const down = (async () => {
  throw new Error('network down')
}) as unknown as typeof fetch

// The shape of Circle's record, read from the pre-event payment on 2026-11-06.
const preEventRecord = {
  transfers: [
    { id: '5a5ba394-146c-4029-b7e4-5f9a4f1668aa', status: 'completed', token: 'USDC', amount: '5000', nonce: PRE_EVENT_NONCE },
  ],
}
const one = { transfers: [{ id: 'transfer-1', status: 'received', token: 'USDC', amount: '200', nonce: EVENT_NONCE }] }
const two = {
  transfers: [
    { id: 'transfer-1', status: 'completed', token: 'USDC', amount: '1000', nonce: EVENT_NONCE },
    { id: 'transfer-2', status: 'received', token: 'USDC', amount: '1500000', nonce: EVENT_NONCE },
  ],
}
const countsTwo = async () => 2

describe('the lines match the spec to the letter', () => {
  test('Circle record, one and several', () => {
    expect(circleLine(1)).toBe('Circle record: 1 transfer for this payment.')
    expect(circleLine(2)).toBe('Circle record: 2 transfers for this payment.')
    expect(circleLine(0)).toBe('Circle record: 0 transfers for this payment.')
  })

  test('Arkiv, one and several', () => {
    expect(arkivLine(1)).toBe('Arkiv: 1 entity for this payment.')
    expect(arkivLine(2)).toBe('Arkiv: 2 entities for this payment.')
    expect(arkivLine(0)).toBe('Arkiv: 0 entities for this payment.')
  })

  test('the pre-event line', () => {
    expect(ARKIV_NOT_USED).toBe('Arkiv: not used before the event.')
  })

  test('an amount is whole USDC, not the atomic units Circle reports', () => {
    expect(amountLine('5000')).toBe('0.005 USDC')
    expect(amountLine('1000000')).toBe('1 USDC')
  })
})

describe('which Circle host', () => {
  test('production for the pre-event payment, in any letter case', () => {
    expect(circleHostFor(PRE_EVENT_NONCE)).toBe(CIRCLE_PRODUCTION)
    expect(circleHostFor(PRE_EVENT_NONCE.toUpperCase().replace('0X', '0x'))).toBe(CIRCLE_PRODUCTION)
  })

  test('testnet for the event payment and any other nonce', () => {
    expect(circleHostFor(EVENT_NONCE)).toBe(CIRCLE_TESTNET)
  })

  test('the read goes straight to Circle, with no vet402 server', async () => {
    const urls: string[] = []
    const spy = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(one))
    }) as unknown as typeof fetch
    await readCircle(EVENT_NONCE, spy)
    expect(urls).toEqual([`https://gateway-api-testnet.circle.com/v1/x402/transfers?nonce=${EVENT_NONCE}`])
  })
})

describe('readCircle', () => {
  test('returns the transfers', async () => {
    expect(await readCircle(PRE_EVENT_NONCE, answering(preEventRecord))).toHaveLength(1)
  })

  test('an empty record is an answer', async () => {
    expect(await readCircle('0xdead', answering({ transfers: [] }))).toEqual([])
  })

  test('HTTP 500 is a failed read', async () => {
    expect(await readCircle('0x1', answering({}, 500))).toBeNull()
  })

  test('a network error is a failed read', async () => {
    expect(await readCircle('0x1', down)).toBeNull()
  })

  test('a body with no list, or a malformed amount, is a failed read and never "0 transfers"', async () => {
    expect(await readCircle('0x1', answering({ error: 'nope' }))).toBeNull()
    expect(await readCircle('0x1', answering({ transfers: [{ id: 'a', status: 'x', amount: '1.5' }] }))).toBeNull()
  })
})

describe('checkReceipt', () => {
  test('one transfer: count, status and amount, then Arkiv', async () => {
    const result = await checkReceipt(EVENT_NONCE, { fetchImpl: answering(one), countEntities: async () => 1 })
    expect(result.circle).toEqual(['Circle record: 1 transfer for this payment.', 'received', '0.0002 USDC'])
    expect(result.arkiv).toBe('Arkiv: 1 entity for this payment.')
  })

  test('several transfers: every status and amount, and every transfer id goes to Arkiv', async () => {
    let asked: string[] = []
    const result = await checkReceipt(EVENT_NONCE, {
      fetchImpl: answering(two),
      countEntities: async (ids) => {
        asked = ids
        return 3
      },
    })
    expect(result.circle).toEqual([
      'Circle record: 2 transfers for this payment.',
      'completed',
      '0.001 USDC',
      'received',
      '1.5 USDC',
    ])
    expect(asked).toEqual(['transfer-1', 'transfer-2'])
    expect(result.arkiv).toBe('Arkiv: 3 entities for this payment.')
  })

  test('zero transfers: zero on both lines', async () => {
    const result = await checkReceipt('0x0', { fetchImpl: answering({ transfers: [] }), countEntities: countsTwo })
    expect(result.circle).toEqual(['Circle record: 0 transfers for this payment.'])
    expect(result.arkiv).toBe('Arkiv: 0 entities for this payment.')
  })

  test('the pre-event payment says Arkiv was not used, and never asks Arkiv', async () => {
    const result = await checkReceipt(PRE_EVENT_NONCE, {
      fetchImpl: answering(preEventRecord),
      countEntities: async () => {
        throw new Error('Arkiv must not be read')
      },
    })
    expect(result.circle).toEqual(['Circle record: 1 transfer for this payment.', 'completed', '0.005 USDC'])
    expect(result.arkiv).toBe('Arkiv: not used before the event.')
  })

  test('Circle fails, Arkiv stays: the transfer id the page knows still reads Arkiv', async () => {
    const result = await checkReceipt(EVENT_NONCE, {
      fetchImpl: answering({}, 500),
      countEntities: countsTwo,
      knownTransferId: 'transfer-1',
    })
    expect(result.circle).toEqual([COULD_NOT_READ_CIRCLE])
    expect(result.arkiv).toBe('Arkiv: 2 entities for this payment.')
  })

  test('Circle fails with no known id: Arkiv says it could not read, never "0 entities"', async () => {
    const result = await checkReceipt('0x1', { fetchImpl: down, countEntities: countsTwo })
    expect(result.circle).toEqual([COULD_NOT_READ_CIRCLE])
    expect(result.arkiv).toBe(COULD_NOT_READ_ARKIV)
  })

  test('Arkiv fails, Circle stays', async () => {
    const result = await checkReceipt(EVENT_NONCE, {
      fetchImpl: answering(one),
      countEntities: async () => {
        throw new Error('rpc')
      },
    })
    expect(result.circle[0]).toBe('Circle record: 1 transfer for this payment.')
    expect(result.arkiv).toBe(COULD_NOT_READ_ARKIV)
  })

  test('the pre-event payment keeps its Arkiv line when Circle fails', async () => {
    const result = await checkReceipt(PRE_EVENT_NONCE, { fetchImpl: down, countEntities: null })
    expect(result).toEqual({ circle: [COULD_NOT_READ_CIRCLE], arkiv: ARKIV_NOT_USED })
  })

  test('a build with no writer cannot read Arkiv, and says so', async () => {
    const result = await checkReceipt(EVENT_NONCE, { fetchImpl: answering(one), countEntities: null })
    expect(result.circle[0]).toBe('Circle record: 1 transfer for this payment.')
    expect(result.arkiv).toBe(COULD_NOT_READ_ARKIV)
  })

  test('spaces around a pasted nonce do not matter', async () => {
    const result = await checkReceipt(`  ${PRE_EVENT_NONCE}\n`, { fetchImpl: answering(preEventRecord), countEntities: null })
    expect(result.arkiv).toBe(ARKIV_NOT_USED)
  })
})

describe('createArkivCounter', () => {
  const answerWith = (keysById: Record<string, string[]>, queries: string[]) =>
    custom({
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        if (method !== 'arkiv_query') throw new Error(`unexpected ${method}`)
        const query = params[0] as string
        queries.push(query)
        const id = /gateway_transfer_id = str\('([^']*)'\)/.exec(query)?.[1] ?? ''
        const attributes = [{ name: 'arkiv.schema', type: 'str', value: 'vet402_receipt' }]
        return { data: (keysById[id] ?? []).map((key) => ({ key, attributes })), blockNumber: '0x1' }
      },
    })

  test('asks the receipt schema, by owner and transfer id, across kinds', async () => {
    const queries: string[] = []
    const count = createArkivCounter(WRITER, answerWith({ 'transfer-1': ['0xaa', '0xbb'] }, queries))
    expect(await count(['transfer-1'])).toBe(2)
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain("arkiv.schema = str('vet402_receipt')")
    expect(queries[0]?.toLowerCase()).toContain(`$owner = addr(${WRITER})`)
    expect(queries[0]).toContain("gateway_transfer_id = str('transfer-1')")
    // Both the payment and the settlement entity count, so no filter on kind.
    expect(queries[0]).not.toContain('kind =')
  })

  test('an entity seen twice counts once', async () => {
    const count = createArkivCounter(WRITER, answerWith({ a: ['0xaa'], b: ['0xaa', '0xbb'] }, []))
    expect(await count(['a', 'b'])).toBe(2)
  })
})
