import { describe, expect, test } from 'bun:test'
import express from 'express'
import { keccak256, stringToHex } from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createLocalFacilitator, createLocalPayer } from '../examples/localPayment'
import { checkBox, openBox, openSealed, paymentAuthOf, promiseSigner, sealAndPromise, sealedDelivery, boxToPromiseForTest } from './imports'
import type { PaymentRequirement, SealedBox } from '../src/index'
import { CHAIN_ID, CONTRACT, DOMAIN, offlineChain, serve } from './helpers'

const sellerKey = generatePrivateKey()
const buyerKey = generatePrivateKey()
const seller = privateKeyToAccount(sellerKey).address
const buyer = privateKeyToAccount(buyerKey).address
const nonce = keccak256(stringToHex('payment 1'))

const accepts: PaymentRequirement = {
  scheme: 'exact',
  network: `eip155:${CHAIN_ID}`,
  asset: '0x3600000000000000000000000000000000000000',
  amount: '1000',
  payTo: seller,
  extra: { name: DOMAIN.name, version: DOMAIN.version, verifyingContract: DOMAIN.verifyingContract },
}

describe('the promise', () => {
  test('is signed by the seller over the contract domain and bound to one buyer and payment', async () => {
    const { box, key } = await sealAndPromise({ plaintext: 'hello', sellerKey, buyer, value: 1000n, paymentNonce: nonce, chainId: CHAIN_ID, contract: CONTRACT })
    expect(await promiseSigner(boxToPromiseForTest(box), box.sellerSignature, CHAIN_ID, CONTRACT)).toBe(seller)
    expect(await promiseSigner(boxToPromiseForTest(box), box.sellerSignature, CHAIN_ID + 1, CONTRACT)).not.toBe(seller)
    const auth = { from: buyer, to: seller, value: 1000n, nonce }
    expect(await checkBox(box, auth, CHAIN_ID, CONTRACT)).toBeNull()
    expect(await checkBox(box, { ...auth, from: seller }, CHAIN_ID, CONTRACT)).toBe('wrong buyer')
    expect(await checkBox(box, { ...auth, value: 999n }, CHAIN_ID, CONTRACT)).toBe('wrong value')
    expect(await checkBox(box, { ...auth, nonce: keccak256('0x01') }, CHAIN_ID, CONTRACT)).toBe('wrong nonce')
    expect(await checkBox(box, auth, CHAIN_ID, CONTRACT, Number(box.promise.expiry))).toBe('promise expired')
    const tampered: SealedBox = { ...box, ciphertext: `${box.ciphertext.slice(0, -2)}00` as Hex }
    expect(await checkBox(tampered, auth, CHAIN_ID, CONTRACT)).toBe('wrong ciphertext')
    const opened = openBox(box, key)!
    expect(new TextDecoder().decode(opened.bytes)).toBe('hello')
    expect(opened.matches).toBe(true)
    expect(openBox(box, generatePrivateKey())).toBeNull()
  })
})

describe('the seller middleware', () => {
  async function shop(route: (req: express.Request, res: express.Response) => void) {
    const { facilitator, settled } = createLocalFacilitator(DOMAIN)
    const sealed = sealedDelivery({ contract: CONTRACT, sellerKey, facilitator, accepts, rpcUrl: 'http://127.0.0.1:1', watch: false, chain: offlineChain() })
    const app = express()
    app.use('/answer', sealed)
    app.get('/answer', route)
    const server = await serve(app)
    return { url: `${server.url}/answer`, settled, close: server.close }
  }
  const pay = createLocalPayer(buyerKey, DOMAIN)
  const get = (url: string, header?: string) => fetch(url, header ? { headers: { 'PAYMENT-SIGNATURE': header } } : {})

  test('asks for payment, seals the answer, settles once, and gives the key only to that payment', async () => {
    const s = await shop((_req, res) => res.json({ answer: 42 }))
    try {
      const unpaid = await get(s.url)
      expect(unpaid.status).toBe(402)
      expect(unpaid.headers.get('PAYMENT-REQUIRED')).toBeTruthy()
      expect(((await unpaid.json()) as { accepts: unknown[] }).accepts).toEqual([accepts])

      const header = await pay(accepts)
      const paid = await get(s.url, header)
      expect(paid.status).toBe(200)
      const { sealed } = (await paid.json()) as { sealed: SealedBox }
      expect(sealed.ciphertext).not.toContain(Buffer.from('42').toString('hex'))
      expect(s.settled.size).toBe(1)

      const again = (await (await get(s.url, header)).json()) as { sealed: SealedBox }
      expect(again.sealed).toEqual(sealed)
      expect(s.settled.size).toBe(1)

      const otherHeader = await pay(accepts)
      expect((await get(`${s.url}/key`, otherHeader)).status).toBe(409)
      const { key } = (await (await get(`${s.url}/key`, header)).json()) as { key: Hex }
      const opened = openBox(sealed, key)!
      expect(JSON.parse(new TextDecoder().decode(opened.bytes))).toEqual({ answer: 42 })
      expect(opened.matches).toBe(true)
      expect(paymentAuthOf(header).auth.nonce).toBe(sealed.promise.paymentNonce)
    } finally {
      s.close()
    }
  })

  test('settles nothing when the route fails or the amount is wrong', async () => {
    const s = await shop((_req, res) => res.status(500).json({ error: 'down' }))
    try {
      const failed = await get(s.url, await pay(accepts))
      expect(failed.status).toBe(500)
      expect(await failed.json()).toEqual({ error: 'down' })
      expect((await get(s.url, await pay({ ...accepts, amount: '1' }))).status).toBe(402)
      expect(s.settled.size).toBe(0)
    } finally {
      s.close()
    }
  })

  test('refuses a payTo that is not the seller key', () => {
    expect(() =>
      sealedDelivery({ contract: CONTRACT, sellerKey, facilitator: createLocalFacilitator(DOMAIN).facilitator, accepts: { ...accepts, payTo: buyer }, rpcUrl: '', chain: offlineChain() }),
    ).toThrow('payTo')
  })

  test('openSealed opens the box with the key from the key route, without the chain', async () => {
    const s = await shop((_req, res) => res.json({ answer: 'sealed and opened' }))
    try {
      const result = await openSealed({ url: s.url, paymentHeader: await pay(accepts), contract: CONTRACT, rpcUrl: '', chain: offlineChain() })
      expect(result.status).toBe('opened')
      expect(result.via).toBe('key-route')
      expect(JSON.parse(result.text!)).toEqual({ answer: 'sealed and opened' })
    } finally {
      s.close()
    }
  })
})
