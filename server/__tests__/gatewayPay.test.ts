import { describe, expect, test } from 'bun:test'
import { verifyTypedData } from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  ARC_CAIP2,
  ARC_GATEWAY_API,
  ARC_GATEWAY_WALLET,
  ARC_USDC,
  arcGatewayAcceptOf,
  arcGatewayAcceptWithSellerExtra,
  encodePaymentHeader,
} from '../../src/existing/arc-gateway'
import { getProtocolContractByName, getUsdc, requireChain } from '../../src/onchain-facts'
import { payFromHold } from '../gatewayPay'

// Nothing here reads or writes a file. Keys are made in memory for each test, so the app's .env
// and data folder are never touched. `bun run test` also runs from an empty temporary folder.

const PAY_TO = `0x${'12'.repeat(20)}`

const goodAccept = (overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: ARC_CAIP2,
  asset: ARC_USDC,
  amount: '100',
  payTo: PAY_TO,
  maxTimeoutSeconds: 604900,
  extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: ARC_GATEWAY_WALLET, ...extra },
  ...overrides,
})

describe('The pins are Arc testnet', () => {
  test('match what Arc Studio knows about the chain', () => {
    const chain = requireChain(5042002)
    expect(ARC_CAIP2).toBe('eip155:5042002')
    expect(ARC_USDC.toLowerCase()).toBe(getUsdc(5042002)?.address.toLowerCase())
    expect(ARC_GATEWAY_WALLET.toLowerCase()).toBe(
      getProtocolContractByName('GatewayWallet', 'testnet')?.address.toLowerCase(),
    )
    expect(ARC_GATEWAY_WALLET).toBe('0x0077777d7EBA4688BDeF3E311b846F25870A19B9')
    expect(ARC_GATEWAY_API).toBe('https://gateway-api-testnet.circle.com/v1')
    expect(chain.isTestnet).toBe(true)
  })
})

describe('The accept checks are all still there', () => {
  test('a good testnet accept passes', () => {
    expect(arcGatewayAcceptOf(goodAccept())).not.toBeNull()
  })

  test.each([
    ['the old network', goodAccept({ network: 'eip155:5042' })],
    ['another network', goodAccept({ network: 'eip155:8453' })],
    ['a scheme other than exact', goodAccept({ scheme: 'upto' })],
    ['a non-numeric amount', goodAccept({ amount: '1.5' })],
    ['another asset', goodAccept({ asset: `0x${'99'.repeat(20)}` })],
    ['a bad payTo', goodAccept({ payTo: 'nope' })],
    ['a different name', goodAccept({}, { name: 'USDC' })],
    ['a different version', goodAccept({}, { version: '2' })],
    ['a different wallet', goodAccept({}, { verifyingContract: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE' })],
    ['a salt', goodAccept({}, { salt: '0x00' })],
    ['the old chain id', goodAccept({}, { chainId: 5042 })],
    ['a timeout that is too long', goodAccept({ maxTimeoutSeconds: 604901 })],
    ['a fractional timeout', goodAccept({ maxTimeoutSeconds: 10.5 })],
    ['no extra', goodAccept({ extra: undefined })],
  ])('rejects %s', (_name, accept) => {
    expect(arcGatewayAcceptOf(accept)).toBeNull()
    expect(arcGatewayAcceptWithSellerExtra(accept)).toBeNull()
  })

  test('accepts the new chain id as a number or a string', () => {
    expect(arcGatewayAcceptOf(goodAccept({}, { chainId: 5042002 }))).not.toBeNull()
    expect(arcGatewayAcceptOf(goodAccept({}, { chainId: '5042002' }))).not.toBeNull()
  })
})

describe("The seller's own extra", () => {
  const sellerExtra = {
    name: 'GatewayWalletBatched',
    version: '1',
    verifyingContract: ARC_GATEWAY_WALLET.toLowerCase(),
    minValiditySeconds: 604800,
    assets: [{ symbol: 'USDC', address: ARC_USDC, decimals: 6 }],
    custom: { requiredByThisSeller: true },
  }

  test('the checked accept drops the fields the file does not keep', () => {
    expect(arcGatewayAcceptOf(goodAccept({ extra: sellerExtra }))?.extra).toEqual({
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: ARC_GATEWAY_WALLET.toLowerCase(),
    })
  })

  test('is put back, unchanged, once the checks pass', () => {
    const accept = arcGatewayAcceptWithSellerExtra(goodAccept({ extra: sellerExtra }))
    expect(accept?.extra).toEqual(sellerExtra)
    expect(accept?.extra).not.toBe(sellerExtra)
  })

  test('is never put back on an accept that fails a check', () => {
    expect(arcGatewayAcceptWithSellerExtra(goodAccept({ network: 'eip155:5042', extra: sellerExtra }))).toBeNull()
    expect(arcGatewayAcceptWithSellerExtra(goodAccept({ extra: { ...sellerExtra, salt: '0x1' } }))).toBeNull()
  })

  test('ends up in the payment header', () => {
    const accept = arcGatewayAcceptWithSellerExtra(goodAccept({ extra: sellerExtra }))
    if (!accept) throw new Error('expected an accept')
    const { headerName, headerValue } = encodePaymentHeader({
      x402Version: 2,
      accept,
      payload: { transaction: 'x' },
      resourceUrl: 'https://seller.example.com/x',
    })
    const body = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')) as {
      accepted: { extra: unknown }
    }
    expect(headerName).toBe('PAYMENT-SIGNATURE')
    expect(body.accepted.extra).toEqual(sellerExtra)
  })
})

describe('Paying through the vet402 code', () => {
  const holdKey: Hex = generatePrivateKey()
  const hold = privateKeyToAccount(holdKey)
  const available = (amount: bigint) => () => Promise.resolve(amount)

  const sellerExtra = {
    name: 'GatewayWalletBatched',
    version: '1',
    // Lower case on purpose: the header must keep the seller's spelling.
    verifyingContract: ARC_GATEWAY_WALLET.toLowerCase(),
    minValiditySeconds: 604800,
    assets: [{ symbol: 'USDC', address: ARC_USDC, decimals: 6 }],
  }
  const sellerResource = { url: 'https://seller.example.com/thing', description: 'x'.repeat(10_000), mimeType: 'application/json' }

  function startSeller(amount: string, answer = '{ "ok": true }\n') {
    const seen = { unpaid: 0, paid: 0, headerChars: 0, signature: '' }
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const signature = req.headers.get('payment-signature')
        if (!signature) {
          seen.unpaid++
          const header = Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: sellerResource,
              accepts: [
                // An option on another network comes first and must be skipped.
                goodAccept({ network: 'eip155:8453', extra: sellerExtra }),
                goodAccept({ amount, extra: sellerExtra }),
              ],
            }),
          ).toString('base64')
          seen.headerChars = header.length
          return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': header } })
        }
        seen.paid++
        seen.signature = signature
        const settled = Buffer.from(
          JSON.stringify({ success: true, transaction: 'b2f1c1de-0000-4000-8000-000000000001' }),
        ).toString('base64')
        return new Response(answer, { headers: { 'PAYMENT-RESPONSE': settled, 'Content-Type': 'application/json' } })
      },
    })
    return { server, seen, url: `http://localhost:${server.port}/thing` }
  }

  test('handles a very large 402 header on the server and hands back only the result', async () => {
    const { server, seen, url } = startSeller('100')
    try {
      const outcome = await payFromHold({ holdKey, holdAvailable: available(1_000n) }, { url, method: 'GET' }, 100n)

      expect(seen.headerChars).toBeGreaterThan(10_000)
      expect(seen.paid).toBe(1)
      expect(outcome.data).toEqual({ ok: true })
      expect(outcome.body).toBe('{ "ok": true }\n')
      expect(outcome.paid).toBe(100n)
      expect(outcome.timesReceived).toBe(1)
      expect(outcome.nonce).toMatch(/^0x[0-9a-f]{64}$/i)
      expect(outcome.transaction).toBe('b2f1c1de-0000-4000-8000-000000000001')
      expect(Object.keys(outcome).sort()).toEqual(['body', 'data', 'nonce', 'paid', 'timesReceived', 'transaction'])
    } finally {
      await server.stop(true)
    }
  })

  test("sends the seller's own extra and resource back, and signs with the hold key and the pinned wallet", async () => {
    const { server, seen, url } = startSeller('100')
    try {
      await payFromHold({ holdKey, holdAvailable: available(1_000n) }, { url, method: 'GET' }, 100n)

      const header = JSON.parse(Buffer.from(seen.signature, 'base64').toString('utf8')) as {
        resource: unknown
        accepted: { network: string; extra: unknown }
        payload: { signature: Hex; authorization: Record<string, string> }
      }
      expect(header.accepted.extra).toEqual(sellerExtra)
      expect(header.accepted.network).toBe(ARC_CAIP2)
      expect(header.resource).toEqual(sellerResource)

      const { authorization, signature } = header.payload
      expect(authorization.from).toBe(hold.address)
      expect(authorization.value).toBe('100')

      const valid = await verifyTypedData({
        address: hold.address,
        domain: { name: 'GatewayWalletBatched', version: '1', chainId: 5042002, verifyingContract: ARC_GATEWAY_WALLET as Hex },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from as Hex,
          to: authorization.to as Hex,
          value: BigInt(authorization.value ?? '0'),
          validAfter: BigInt(authorization.validAfter ?? '0'),
          validBefore: BigInt(authorization.validBefore ?? '0'),
          nonce: authorization.nonce as Hex,
        },
        signature,
      })
      expect(valid).toBe(true)
    } finally {
      await server.stop(true)
    }
  })

  test('pays nothing when the seller asks for more than was approved', async () => {
    const { server, seen, url } = startSeller('500')
    try {
      await expect(
        payFromHold({ holdKey, holdAvailable: available(1_000n) }, { url, method: 'GET' }, 100n),
      ).rejects.toThrow('approved amount')
      expect(seen.paid).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test('pays nothing when the hold does not cover the price', async () => {
    const { server, seen, url } = startSeller('100')
    try {
      await expect(
        payFromHold({ holdKey, holdAvailable: available(99n) }, { url, method: 'GET' }, 100n),
      ).rejects.toThrow('hold does not cover')
      expect(seen.paid).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test('pays nothing when no option passes the checks', async () => {
    const seen = { paid: 0 }
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.headers.get('payment-signature')) seen.paid++
        const header = Buffer.from(
          JSON.stringify({ x402Version: 2, resource: {}, accepts: [goodAccept({ network: 'eip155:5042' })] }),
        ).toString('base64')
        return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': header } })
      },
    })
    try {
      await expect(
        payFromHold(
          { holdKey, holdAvailable: available(1_000n) },
          { url: `http://localhost:${server.port}/x`, method: 'GET' },
          100n,
        ),
      ).rejects.toThrow('may sign')
      expect(seen.paid).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test('does not follow a redirect to another address', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.redirect('http://localhost:9/elsewhere', 302) })
    try {
      await expect(
        payFromHold(
          { holdKey, holdAvailable: available(1_000n) },
          { url: `http://localhost:${server.port}/x`, method: 'GET' },
          100n,
        ),
      ).rejects.toThrow()
    } finally {
      await server.stop(true)
    }
  })

  test('sends a POST body on both requests', async () => {
    const bodies: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push(await req.text())
        if (!req.headers.get('payment-signature')) {
          const header = Buffer.from(
            JSON.stringify({ x402Version: 2, resource: {}, accepts: [goodAccept({ extra: sellerExtra })] }),
          ).toString('base64')
          return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': header } })
        }
        return Response.json({ result: null })
      },
    })
    try {
      await payFromHold(
        { holdKey, holdAvailable: available(1_000n) },
        { url: `http://localhost:${server.port}/x`, method: 'POST', body: { jsonrpc: '2.0', id: 1 } },
        100n,
      )
      expect(bodies).toEqual(['{"jsonrpc":"2.0","id":1}', '{"jsonrpc":"2.0","id":1}'])
    } finally {
      await server.stop(true)
    }
  })
})
