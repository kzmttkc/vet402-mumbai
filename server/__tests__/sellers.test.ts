import { afterEach, describe, expect, test } from 'bun:test'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { Server } from 'node:http'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ARC_CAIP2, ARC_GATEWAY_WALLET, ARC_USDC } from '../../src/existing/arc-gateway'
import { preparePayment } from '../gatewayPay'
import { createSeller, DEMO_PRICE, paymentRequired } from '../sellers'
import type { SellerConfig, SellerFacilitator } from '../sellers'

// Everything runs in memory against local servers. No file is read or written, and the keys
// are made fresh for each test, so the app's .env and data folder are never touched.

const holdKey = generatePrivateKey()
const hold = privateKeyToAccount(holdKey)
const sellerAddress = privateKeyToAccount(generatePrivateKey()).address

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections()
})

/** A facilitator that behaves like Gateway: a nonce can be settled once. */
function fakeFacilitator() {
  const calls = { verify: 0, settle: 0 }
  const used = new Set<string>()
  const nonceOf = (payload: unknown) =>
    (payload as { payload: { authorization: { nonce: string } } }).payload.authorization.nonce
  const facilitator: SellerFacilitator = {
    verify: (payload) => {
      calls.verify++
      return Promise.resolve(used.has(nonceOf(payload)) ? { isValid: false, invalidReason: 'nonce used' } : { isValid: true })
    },
    settle: (payload) => {
      calls.settle++
      used.add(nonceOf(payload))
      return Promise.resolve({ success: true, transaction: 'transfer-1' })
    },
  }
  return { facilitator, calls }
}

interface Options {
  declaresRecovery?: boolean
  drop?: boolean
  charged?: boolean
}

async function startSeller({ declaresRecovery = true, drop = true, charged = true }: Options = {}) {
  const { facilitator, calls } = fakeFacilitator()
  const confirmations: { nonce: string; payer: string }[] = []
  const config: SellerConfig = {
    name: 'Seller',
    payTo: sellerAddress,
    declaresRecovery,
    facilitator,
    confirmCharged: (nonce, payer) => {
      confirmations.push({ nonce, payer })
      return Promise.resolve(charged)
    },
    dropAfterSettle: () => drop,
  }
  const hits = { paid: 0 }
  const handler = createSeller(config)
  const app = express()
  app.get('/s', (req, res) => {
    if (req.get('payment-signature')) hits.paid++
    void handler(req, res)
  })
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  servers.push(server)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/s`
  return { url, calls, confirmations, hits, config }
}

async function prepare(url: string) {
  const challenge = await preparePayment({ holdKey, holdAvailable: () => Promise.resolve(1_000_000n) }, { url, method: 'GET' }, DEMO_PRICE)
  if (challenge.kind !== 'priced') throw new Error('expected a price')
  return challenge.payment
}

describe('What a seller asks for', () => {
  const base: SellerConfig = {
    name: 'Seller',
    payTo: sellerAddress,
    declaresRecovery: true,
    facilitator: fakeFacilitator().facilitator,
    confirmCharged: () => Promise.resolve(true),
    dropAfterSettle: () => false,
  }

  test('seller A builds its own payment terms from constants and adds the recovery promise', () => {
    const [accept] = paymentRequired(base, 'http://x/s').accepts
    expect(accept).toMatchObject({
      scheme: 'exact',
      network: ARC_CAIP2,
      asset: ARC_USDC,
      amount: '1000',
      payTo: sellerAddress,
      extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: ARC_GATEWAY_WALLET, recovery: 'same-payment' },
    })
    expect(ARC_CAIP2).toBe('eip155:5042002')
    expect(ARC_GATEWAY_WALLET).toBe('0x0077777d7EBA4688BDeF3E311b846F25870A19B9')
    // The token contract address, never the symbol.
    expect(accept?.asset).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(accept?.asset).not.toBe('USDC')
  })

  test('seller B declares nothing', () => {
    const [accept] = paymentRequired({ ...base, declaresRecovery: false }, 'http://x/s').accepts
    expect(Object.keys(accept?.extra ?? {}).sort()).toEqual(['name', 'verifyingContract', 'version'])
  })

  test('the price is 0.001 USDC', () => {
    expect(DEMO_PRICE).toBe(1000n)
  })
})

describe('Seller A', () => {
  test('closes the connection after settling, then gives the stored answer for the same payment', async () => {
    const seller = await startSeller()
    const payment = await prepare(seller.url)

    // First paid request: settled, then the connection closes before any response.
    await expect(payment.send()).rejects.toThrow()
    expect(seller.calls).toEqual({ verify: 1, settle: 1 })
    // The HTTP function sent it once and did not try again on its own.
    expect(seller.hits.paid).toBe(1)

    // The same payment again: no new signature, no second verify or settle.
    const again = await payment.send()
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ seller: 'Seller' })
    expect(seller.calls).toEqual({ verify: 1, settle: 1 })
    expect(seller.hits.paid).toBe(2)
    expect(seller.confirmations).toEqual([{ nonce: payment.nonce, payer: hold.address }])
  })

  test('gives no body when Circle’s record does not show the payment', async () => {
    const seller = await startSeller({ charged: false })
    const payment = await prepare(seller.url)
    await expect(payment.send()).rejects.toThrow()

    const again = await payment.send()
    expect(again.status).toBe(409)
    expect(await again.text()).toBe('')
  })

  test('gives the stored answer only for the very same payment', async () => {
    const seller = await startSeller()
    const payment = await prepare(seller.url)
    await expect(payment.send()).rejects.toThrow()

    // Same nonce, different header: not the same payment payload.
    const decoded = JSON.parse(Buffer.from(payment.header.value, 'base64').toString('utf8')) as Record<string, unknown>
    const altered = Buffer.from(JSON.stringify({ ...decoded, note: 'changed' })).toString('base64')
    const res = await fetch(seller.url, { headers: { 'Payment-Signature': altered } })

    expect(res.status).toBe(409)
    expect(await res.text()).toBe('')
  })

  test('delivers straight away when the switch is off', async () => {
    const seller = await startSeller({ drop: false })
    const payment = await prepare(seller.url)
    const res = await payment.send()
    expect(res.status).toBe(200)
    expect(seller.calls).toEqual({ verify: 1, settle: 1 })
    expect(seller.confirmations).toHaveLength(0)
  })

  test('refuses a payment to someone else or for another amount, without asking Gateway', async () => {
    const seller = await startSeller()
    const payment = await prepare(seller.url)
    const decoded = JSON.parse(Buffer.from(payment.header.value, 'base64').toString('utf8')) as {
      payload: { authorization: Record<string, string> }
    }
    decoded.payload.authorization.value = '1'
    const res = await fetch(seller.url, { headers: { 'Payment-Signature': Buffer.from(JSON.stringify(decoded)).toString('base64') } })

    expect(res.status).toBe(402)
    expect(seller.calls).toEqual({ verify: 0, settle: 0 })
  })
})

describe('Seller B', () => {
  test('closes the connection after settling and has nothing to give again', async () => {
    const seller = await startSeller({ declaresRecovery: false })
    const payment = await prepare(seller.url)
    expect(payment.accept.extra?.recovery).toBeUndefined()

    await expect(payment.send()).rejects.toThrow()
    expect(seller.calls.settle).toBe(1)

    // Even if the same payment is sent again, there is no answer and no second settlement.
    const again = await fetch(seller.url, { headers: { [payment.header.name]: payment.header.value } })
    expect(again.status).toBe(402)
    expect((await again.text()).includes('Here is the answer')).toBe(false)
    expect(seller.calls.settle).toBe(1)
  })
})
