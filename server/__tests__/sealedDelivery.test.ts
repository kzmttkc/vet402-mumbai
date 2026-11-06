import { afterEach, describe, expect, test } from 'bun:test'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { keccak256 } from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { createDemoService, DemoError } from '../demo'
import type { DemoPorts, DemoRunView } from '../demo'
import { preparePayment } from '../gatewayPay'
import type { PreparedPayment } from '../gatewayPay'
import {
  claimIdOf,
  createSealedDelivery,
  createSealer,
  createSellerWatcher,
  parseSealedAddress,
  paymentAuthOf,
} from '../sealedDelivery'
import type { SealedBox, SealedPorts, WatcherOptions } from '../sealedDelivery'
import { createSeller, DEMO_PRICE, paymentRequired } from '../sellers'
import type { SellerFacilitator, SellerSealing } from '../sellers'
import { openResponse, sealResponse } from '../../src/lib/sealed'
import { splitLines } from '../../src/lib/receiptLines'
import { memoryStore } from './helpers'

// Everything runs in memory against local servers, and no chain is ever reached: the client below
// points at a closed port and only uses what needs no network. The real contract is covered by
// scripts/sealed-local-e2e.ts.

const CONTRACT = '0x00000000000000000000000000000000000000c1' as const
const offline = createSealedDelivery({
  address: CONTRACT,
  net: { chain: arcTestnet, rpcUrl: 'http://127.0.0.1:1', pollingMs: 10 },
})

const ANSWER = JSON.stringify({ seller: 'Seller', answer: 'Here is the answer you paid for.' })
const CLAIM_ID: Hex = `0x${'c1'.repeat(32)}`

describe('no contract address', () => {
  test('without SEALED_DELIVERY_ADDRESS the sealed path is off', () => {
    expect(parseSealedAddress(undefined)).toBeNull()
    expect(parseSealedAddress('')).toBeNull()
    expect(parseSealedAddress('not-an-address')).toBeNull()
    expect(parseSealedAddress(CONTRACT)).toBe(CONTRACT)
  })

  test('without SEALED_DELIVERY_ADDRESS Seller A runs the same-payment path and nothing else', async () => {
    let sends = 0
    const ports: DemoPorts = {
      holdAvailable: () => Promise.resolve(1_000_000n),
      growHold: () => Promise.resolve(),
      prepare: () =>
        Promise.resolve({
          accept: { scheme: 'exact', network: 'eip155:5042002', amount: '1000', asset: '0x', payTo: '0x', extra: { recovery: 'same-payment' } },
          amount: DEMO_PRICE,
          nonce: `0x${'a'.repeat(64)}`,
          payer: '0xabc',
          header: { name: 'PAYMENT-SIGNATURE', value: 'h' },
          send: () => (++sends === 1 ? Promise.reject(new Error('dropped')) : Promise.resolve(new Response('{"answer":"yes"}'))),
        }),
      confirmOnePayment: () => Promise.resolve(true),
      countPayments: () => Promise.resolve(0),
    }
    const receipts = memoryStore()
    const seller = { name: 'Seller A', url: 'http://s/a', address: '0xa' }
    const demos = createDemoService(ports, { a: seller, b: seller }, receipts)
    const started = demos.start('a')
    await demos.settled(started.id)
    expect(demos.get(started.id)?.steps.map((s) => s.name)).toEqual(['hold', 'payment', 'waiting', 'connection dropped', 'fetching again', 'delivered'])
    expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Delivered on the second fetch.', 'Circle record: 1 transfer for this payment.'])
    expect(demos.get(started.id)?.action).toBeNull()
  })

  test('without SEALED_DELIVERY_ADDRESS Sellers D, E and F do not run', async () => {
    const ports = { holdAvailable: () => Promise.resolve(1n) } as unknown as DemoPorts
    const seller = { name: 'S', url: 'http://s', address: '0xa' }
    const demos = createDemoService(ports, { a: seller, b: seller }, memoryStore())
    const started = demos.start('d')
    await demos.settled(started.id)
    expect(demos.get(started.id)).toMatchObject({ state: 'failed', error: 'This demo is not available.' })
  })
})

describe('seller side', () => {
  const sellerKey = generatePrivateKey()
  const sellerAddress = privateKeyToAccount(sellerKey).address
  const holdKey = generatePrivateKey()
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.closeAllConnections()
  })

  function facilitatorFake() {
    const calls = { settle: 0 }
    const used = new Set<string>()
    const nonceOf = (p: unknown) => (p as { payload: { authorization: { nonce: string } } }).payload.authorization.nonce
    const facilitator: SellerFacilitator = {
      verify: (p) => Promise.resolve(used.has(nonceOf(p)) ? { isValid: false, invalidReason: 'nonce used' } : { isValid: true }),
      settle: (p) => {
        calls.settle++
        used.add(nonceOf(p))
        return Promise.resolve({ success: true, transaction: 't' })
      },
    }
    return { facilitator, calls }
  }

  async function start(options: { sealing: SellerSealing; drop?: () => boolean }) {
    const { facilitator, calls } = facilitatorFake()
    const handler = createSeller({
      name: 'Seller',
      payTo: sellerAddress,
      declaresRecovery: true,
      facilitator,
      confirmCharged: () => Promise.resolve(true),
      dropAfterSettle: options.drop ?? (() => false),
      sealing: options.sealing,
    })
    const app = express()
    app.get('/s', (req, res) => {
      handler(req, res).catch(() => res.status(502).end())
    })
    app.get('/s/key', (req, res) => void handler.key(req, res))
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    servers.push(server)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/s`
    const challenge = await preparePayment({ holdKey, holdAvailable: () => Promise.resolve(1_000_000n) }, { url, method: 'GET' }, DEMO_PRICE)
    if (challenge.kind !== 'priced') throw new Error('expected a price')
    return { url, calls, handler, payment: challenge.payment }
  }

  const honest = (handsOverKey = true): SellerSealing => ({ seal: createSealer(offline, sellerKey), handsOverKey: () => handsOverKey })
  const keyRequest = (url: string, payment: PreparedPayment, value = payment.header.value) =>
    fetch(`${url}/key`, { headers: { [payment.header.name]: value, Connection: 'close' } })

  test('Seller A still says same-payment in its terms', () => {
    const [accept] = paymentRequired(
      {
        name: 'Seller A',
        payTo: sellerAddress,
        declaresRecovery: true,
        facilitator: facilitatorFake().facilitator,
        confirmCharged: () => Promise.resolve(true),
        dropAfterSettle: () => false,
        sealing: honest(),
      },
      'http://x/s',
    ).accepts
    expect(accept?.extra.recovery).toBe('same-payment')
  })

  test('settles once and returns a box signed by the seller for this buyer and nonce', async () => {
    const { calls, payment } = await start({ sealing: honest() })
    const res = await payment.send()
    expect(res.status).toBe(200)
    const { sealed } = (await res.json()) as { sealed: SealedBox }
    expect(calls.settle).toBe(1)
    expect(sealed.promise).toMatchObject({ seller: sellerAddress, buyer: payment.payer, paymentNonce: payment.nonce, value: '1000' })
    const seconds = Number(sealed.promise.expiry) - Math.floor(Date.now() / 1000)
    expect(seconds).toBeGreaterThan(2990)
    expect(seconds).toBeLessThanOrEqual(3000)
    expect(await offline.checkBox(sealed, { payTo: sellerAddress, payer: payment.payer, nonce: payment.nonce, value: DEMO_PRICE })).toBe(true)
    expect(await offline.checkBox(sealed, { payTo: sellerAddress, payer: sellerAddress, nonce: payment.nonce, value: DEMO_PRICE })).toBe(false)
    expect(await offline.checkBox(sealed, { payTo: sellerAddress, payer: payment.payer, nonce: payment.nonce, value: 1n })).toBe(false)
    expect(await offline.checkBox({ ...sealed, ciphertext: '0x00' }, { payTo: sellerAddress, payer: payment.payer, nonce: payment.nonce, value: DEMO_PRICE })).toBe(false)
  })

  test('the key opens the box, and only the exact payment that settled gets it', async () => {
    const { url, payment } = await start({ sealing: honest() })
    const { sealed } = (await (await payment.send()).json()) as { sealed: SealedBox }
    expect((await keyRequest(url, payment, 'e30=')).status).toBe(409)
    const { key } = (await (await keyRequest(url, payment)).json()) as { key: Hex }
    expect(keccak256(key)).toBe(sealed.promise.keyHash)
    const plain = openResponse(sealed.ciphertext, key)
    expect(new TextDecoder().decode(plain)).toBe(ANSWER)
    expect(keccak256(plain)).toBe(sealed.promise.plaintextHash)
  })

  test('the switch closes the connection at the key, after the box was delivered', async () => {
    const { url, payment, handler } = await start({ sealing: honest(false) })
    expect((await payment.send()).status).toBe(200)
    await expect(keyRequest(url, payment)).rejects.toThrow()
    // The lookout still has the key.
    expect(handler.keyFor(payment.nonce)).toMatch(/^0x/)
  })

  test('a box lost on its way comes back on the same payment, settled once', async () => {
    let drop = true
    const { calls, payment } = await start({
      sealing: honest(),
      drop: () => {
        const was = drop
        drop = false
        return was
      },
    })
    await expect(payment.send()).rejects.toThrow()
    const res = await payment.send()
    expect(res.status).toBe(200)
    expect(((await res.json()) as { sealed?: unknown }).sealed).toBeDefined()
    expect(calls.settle).toBe(1)
  })

  test('a seal that fails leaves the buyer uncharged', async () => {
    const { calls, payment } = await start({ sealing: { seal: () => Promise.reject(new Error('no')), handsOverKey: () => true } })
    expect((await payment.send()).status).toBe(502)
    expect(calls.settle).toBe(0)
  })

  test('the lying seller keeps the right key and promises another hash', async () => {
    const lie = 'something else'
    const { box, key } = await createSealer(offline, sellerKey, { lie })(ANSWER, {
      from: privateKeyToAccount(holdKey).address,
      nonce: `0x${'a'.repeat(64)}`,
      value: '1000',
    })
    const typed = box as SealedBox
    expect(keccak256(key)).toBe(typed.promise.keyHash)
    expect(new TextDecoder().decode(openResponse(typed.ciphertext, key))).toBe(lie)
    expect(typed.promise.plaintextHash).toBe(sealResponse(ANSWER).plaintextHash)
  })

  test('claim gets the signed authorization back from the payment header', async () => {
    const { payment } = await start({ sealing: honest() })
    const { auth, signature } = paymentAuthOf(payment.header.value)
    expect(auth).toMatchObject({ from: payment.payer, to: sellerAddress, value: DEMO_PRICE, nonce: payment.nonce })
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
    expect(claimIdOf(sellerAddress, auth.from, auth.nonce)).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('the lookout', () => {
  const sellerKey = generatePrivateKey()
  const nonce: Hex = `0x${'a'.repeat(64)}`
  const KEY: Hex = `0x${'b'.repeat(64)}`

  function setup(over: Partial<WatcherOptions['client']> = {}, mode: WatcherOptions['mode'] = 'answer') {
    const log: string[] = []
    const answers: Hex[] = []
    const rejected: string[] = []
    let block = 10n
    const client: WatcherOptions['client'] = {
      latestBlock: () => Promise.resolve(block++),
      readClaimed: () => Promise.resolve([] as never),
      answer: (_key, _id, key) => {
        answers.push(key)
        return Promise.resolve()
      },
      tryAnswer: () => Promise.resolve('WrongKey'),
      chainTime: () => Promise.resolve(100n),
      ...over,
    }
    const watcher = createSellerWatcher({
      client,
      sellerKey,
      keyFor: () => KEY,
      mode,
      log: (line) => log.push(line),
      onRejected: (_id, name) => rejected.push(name),
    })
    return { watcher, log, answers, rejected }
  }
  const oneClaim = () => Promise.resolve([{ claimId: CLAIM_ID, paymentNonce: nonce, deadline: 200n, seller: '0x', transactionHash: '0x' }] as never)

  test('an RPC failure does not stop the lookout, and no claim is missed after it', async () => {
    let fail = true
    const { watcher, log, answers } = setup({
      readClaimed: () => {
        if (fail) return Promise.reject(new Error('rpc down'))
        return oneClaim()
      },
    })
    await watcher.tick()
    expect(log[0]).toContain('rpc down')
    fail = false
    await watcher.tick()
    expect(answers).toEqual([KEY])
  })

  test('an answer that does not get through is tried again', async () => {
    let tries = 0
    const { watcher, log, answers } = setup({
      readClaimed: oneClaim,
      answer: (_k, _i, key) => {
        if (++tries === 1) return Promise.reject(new Error('out of gas'))
        answers.push(key)
        return Promise.resolve()
      },
    })
    await watcher.tick()
    expect(log[0]).toContain('out of gas')
    await watcher.tick()
    expect(tries).toBe(2)
  })

  test('past the deadline it stops trying', async () => {
    const { watcher, answers } = setup({ readClaimed: oneClaim, chainTime: () => Promise.resolve(200n) })
    await watcher.tick()
    expect(answers).toEqual([])
  })

  test('the wrong-key seller tries once, hears the error, and says nothing more', async () => {
    let tries = 0
    let served = false
    const { watcher, rejected, answers } = setup(
      {
        readClaimed: () => {
          if (served) return Promise.resolve([] as never)
          served = true
          return oneClaim()
        },
        tryAnswer: () => {
          tries++
          return Promise.resolve('WrongKey')
        },
      },
      'wrong-key',
    )
    await watcher.tick()
    await watcher.tick()
    expect(tries).toBe(1)
    expect(rejected).toEqual(['WrongKey'])
    expect(answers).toEqual([])
  })
})

describe('the demo with a contract', () => {
  const PAYER = '0xAbCdEf0000000000000000000000000000000002'
  const NONCE: Hex = `0x${'d'.repeat(64)}`
  const sealed = sealResponse(ANSWER)
  const box: SealedBox = {
    ciphertext: sealed.ciphertext,
    promise: {
      seller: PAYER,
      value: '1000',
      paymentNonce: NONCE,
      keyHash: sealed.keyHash,
      plaintextHash: sealed.plaintextHash,
      ciphertextHash: sealed.ciphertextHash,
      expiry: '9999999999',
      buyer: PAYER,
    },
    sellerSignature: '0x',
  }

  function setup(over: Partial<SealedPorts> = {}, confirmed = true) {
    const log = { claims: 0, finalize: 0, prove: 0, withdraw: 0, sends: 0 }
    const sealedPorts: SealedPorts = {
      coverageFor: () => Promise.resolve(true),
      readBox: () => Promise.resolve({ kind: 'box', box }),
      requestKey: () => Promise.resolve(null),
      claim: () => {
        log.claims++
        return Promise.resolve({ claimId: CLAIM_ID, deadline: 100n, fromBlock: 1n })
      },
      readKey: () => Promise.resolve({ key: sealed.key, block: 7n }),
      chainTime: () => Promise.resolve(50n),
      wrongKeyRejected: () => false,
      finalize: () => {
        log.finalize++
        return Promise.resolve(1000n)
      },
      prove: () => {
        log.prove++
        return Promise.resolve(1000n)
      },
      withdraw: () => {
        log.withdraw++
        return Promise.resolve(1000n)
      },
      ...over,
    }
    const ports: DemoPorts = {
      holdAvailable: () => Promise.resolve(1_000_000n),
      growHold: () => Promise.resolve(),
      prepare: () =>
        Promise.resolve({
          accept: { scheme: 'exact', network: 'eip155:5042002', amount: '1000', asset: '0x', payTo: PAYER, extra: { recovery: 'same-payment' } },
          amount: DEMO_PRICE,
          nonce: NONCE,
          payer: PAYER,
          header: { name: 'PAYMENT-SIGNATURE', value: 'h' },
          send: () => {
            log.sends++
            return Promise.resolve(new Response('{"sealed":{}}'))
          },
        }),
      confirmOnePayment: () => Promise.resolve(confirmed),
      countPayments: () => Promise.resolve(0),
      sealed: sealedPorts,
      sealedPollMs: 1,
    }
    const seller = { name: 'Seller A', url: 'http://s/a', address: PAYER }
    const receipts = memoryStore()
    const demos = createDemoService(ports, { a: seller, b: seller, d: seller, e: seller, f: seller }, receipts)
    return { demos, receipts, log }
  }

  async function run(demos: ReturnType<typeof setup>['demos'], kind: 'a' | 'd' | 'e' | 'f') {
    const started = demos.start(kind)
    await demos.settled(started.id)
    return demos.get(started.id) as DemoRunView
  }

  test('the key comes from the chain and the receipt says so, word for word', async () => {
    const { demos, receipts } = setup()
    const finished = await run(demos, 'a')
    expect(finished.steps.map((s) => s.name)).toEqual(['hold', 'payment', 'waiting', 'waiting', 'fetching again', 'connection dropped', 'claim', 'key on chain', 'opened', 'delivered'])
    expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Key read from Arc.', 'Circle record: 1 transfer for this payment.'])
    expect(receipts.list()[0]?.sealed).toEqual({ ciphertext: sealed.ciphertext, claimId: CLAIM_ID, plaintextHash: sealed.plaintextHash, keyBlock: '7' })
    expect(finished.action).toBeNull()
  })

  test('a key handed over the connection never touches the chain', async () => {
    const { demos, receipts, log } = setup({ requestKey: () => Promise.resolve(sealed.key) })
    await run(demos, 'a')
    expect(log.claims).toBe(0)
    expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Delivered.'])
  })

  test('not covered: no claim, and it ends like Seller B', async () => {
    const { demos, receipts, log } = setup({ coverageFor: () => Promise.resolve(false) })
    await run(demos, 'a')
    expect(log.claims).toBe(0)
    expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Nothing delivered. No second charge.'])
  })

  test('a failed coverage read counts as not covered', async () => {
    const { demos, log } = setup({ coverageFor: () => Promise.reject(new Error('rpc down')) })
    expect((await run(demos, 'a')).state).toBe('done')
    expect(log.claims).toBe(0)
  })

  test('a box that fails the checks is never claimed on', async () => {
    const { demos, receipts, log } = setup({ readBox: () => Promise.resolve({ kind: 'bad' }) })
    await run(demos, 'a')
    expect(log.claims).toBe(0)
    expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Nothing delivered. No second charge.'])
  })

  test('claim out of gas: the run fails, the receipt is written, and the service keeps working', async () => {
    let fail = true
    const { demos, receipts } = setup({
      claim: () => {
        if (fail) return Promise.reject(new Error('insufficient funds for gas'))
        return Promise.resolve({ claimId: CLAIM_ID, deadline: 100n, fromBlock: 1n })
      },
    })
    const finished = await run(demos, 'a')
    expect(finished.state).toBe('failed')
    expect(finished.error).toBe('The demo could not finish. Please try again.')
    expect(finished.error).not.toContain('gas')
    expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Nothing delivered. No second charge.'])
    fail = false
    expect((await run(demos, 'a')).state).toBe('done')
  })

  test('answer never arrives: finalize is offered, the receipt word for word, then the money comes back', async () => {
    const { demos, receipts, log } = setup({ readKey: () => Promise.resolve(null), chainTime: () => Promise.resolve(100n) })
    const finished = await run(demos, 'e')
    expect(finished).toMatchObject({ state: 'done', action: 'finalize' })
    expect(receipts.list()[0]?.outcome).toEqual([])
    const pressed = await demos.act(finished.id, 'finalize')
    expect(receipts.list()[0]?.outcome).toEqual(["The seller didn't deliver. You got 0.001 USDC back.", 'Detail: The seller stayed silent. Its deposit paid 0.001 USDC back.'])
    expect(pressed.action).toBe('withdraw')
    expect((await demos.act(finished.id, 'withdraw')).action).toBeNull()
    expect(log).toMatchObject({ finalize: 1, withdraw: 1 })
  })

  test('RPC failure while reading the key: it keeps reading, and the key still arrives', async () => {
    let reads = 0
    const { demos, receipts } = setup({
      readKey: () => (++reads < 3 ? Promise.reject(new Error('rpc down')) : Promise.resolve({ key: sealed.key, block: 7n })),
    })
    const finished = await run(demos, 'a')
    expect(finished.state).toBe('done')
    expect(reads).toBe(3)
    expect(receipts.list()[0]?.outcome?.[0]).toBe('Charged once. Key read from Arc.')
  })

  test('RPC failure on a button: the press is refused, the button stays, and it works next time', async () => {
    let fail = true
    const { demos, receipts } = setup({
      readKey: () => Promise.resolve(null),
      chainTime: () => Promise.resolve(100n),
      finalize: () => (fail ? Promise.reject(new Error('rpc down')) : Promise.resolve(1000n)),
    })
    const finished = await run(demos, 'e')
    await expect(demos.act(finished.id, 'finalize')).rejects.toBeInstanceOf(DemoError)
    expect(demos.get(finished.id)?.action).toBe('finalize')
    expect(receipts.list()[0]?.outcome).toEqual([])
    fail = false
    expect((await demos.act(finished.id, 'finalize')).action).toBe('withdraw')
  })

  test('the wrong key is on the receipt, then the silence', async () => {
    const { demos, receipts } = setup({
      readKey: () => Promise.resolve(null),
      chainTime: () => Promise.resolve(100n),
      wrongKeyRejected: () => true,
    })
    const finished = await run(demos, 'd')
    expect(receipts.list()[0]?.outcome).toEqual(['The seller sent the wrong key. Arc refused it.', 'Detail: Wrong key rejected by the contract.'])
    await demos.act(finished.id, 'finalize')
    expect(receipts.list()[0]?.outcome).toEqual([
      'The seller sent the wrong key. Arc refused it.', 'Detail: Wrong key rejected by the contract.',
      "The seller didn't deliver. You got 0.001 USDC back.",
      'Detail: The seller stayed silent. Its deposit paid 0.001 USDC back.',
    ])
  })

  test('a swapped answer stops at Prove, and the receipt says so word for word', async () => {
    const lied = sealResponse('something else')
    const swapped: SealedBox = {
      ...box,
      ciphertext: lied.ciphertext,
      promise: { ...box.promise, keyHash: lied.keyHash, ciphertextHash: lied.ciphertextHash },
    }
    const { demos, receipts, log } = setup({
      readBox: () => Promise.resolve({ kind: 'box', box: swapped }),
      readKey: () => Promise.resolve({ key: lied.key, block: 8n }),
    })
    const finished = await run(demos, 'f')
    expect(finished.action).toBe('prove')
    expect(finished.steps.at(-1)?.name).toBe('opened')
    expect((await demos.act(finished.id, 'prove')).action).toBe('withdraw')
    expect(log.prove).toBe(1)
    expect(receipts.list()[0]?.outcome).toEqual([
      "The answer wasn't what the seller promised. You got 0.001 USDC back.",
      "Detail: The answer did not match the seller's promise. Its deposit paid 0.001 USDC back.",
    ])
  })

  // The final contract repays the buyer's gas. Each ending says so on the receipt, in the amounts Arc reported.
  test('answer ending: the claim gas the answer repaid is on the receipt, word for word', async () => {
    const { demos, receipts } = setup({ claimGasRepaid: () => Promise.resolve({ amount: 5698n, sent: true }) })
    const finished = await run(demos, 'a')
    expect(finished).toMatchObject({ state: 'done', action: null })
    expect(receipts.list()[0]?.outcome).toEqual([
      'Charged once. Key read from Arc.',
      'The seller sent the key late and paid back the 0.005698 USDC it cost you to ask for it.',
      'Detail: Claim gas repaid by the seller: 0.005698 USDC.',
      'Circle record: 1 transfer for this payment.',
    ])
  })

  test('answer ending: a repayment whose transfer failed is named as a credit on Arc', async () => {
    const { demos, receipts } = setup({ claimGasRepaid: () => Promise.resolve({ amount: 5698n, sent: false }) })
    await run(demos, 'a')
    expect(receipts.list()[0]?.outcome).toEqual([
      'Charged once. Key read from Arc.',
      'The seller sent the key late. The 0.005698 USDC it cost you to ask for it is waiting for you on Arc.',
      'Detail: Claim gas repaid by the seller as a credit on Arc: 0.005698 USDC.',
      'Circle record: 1 transfer for this payment.',
    ])
  })

  test('answer ending: no ClaimGasRepaid, or a read that keeps failing, adds no line and the run still ends', async () => {
    let reads = 0
    for (const claimGasRepaid of [() => Promise.resolve(null), () => (reads++, Promise.reject(new Error('rpc down')))]) {
      const { demos, receipts } = setup({ claimGasRepaid })
      expect((await run(demos, 'a')).state).toBe('done')
      expect(receipts.list()[0]?.outcome).toEqual(['Charged once. Key read from Arc.', 'Circle record: 1 transfer for this payment.'])
    }
    expect(reads).toBe(2)
  })

  test('silent ending (Seller E): the payout is named as the price and the gas of the dispute, word for word', async () => {
    const { demos, receipts } = setup({
      readKey: () => Promise.resolve(null),
      chainTime: () => Promise.resolve(100n),
      finalize: () => Promise.resolve(13268n),
    })
    const finished = await run(demos, 'e')
    await demos.act(finished.id, 'finalize')
    expect(receipts.list()[0]?.outcome).toEqual([
      "The seller didn't deliver. You got 0.013268 USDC back: your 0.001 USDC and your costs.",
      'Detail: The seller stayed silent. Its deposit paid 0.013268 USDC back: the 0.001 USDC price and 0.012268 USDC for the gas of the dispute.',
    ])
  })

  test('silent ending (Seller D): the wrong key, then the price and the gas of the dispute, word for word', async () => {
    const { demos, receipts } = setup({
      readKey: () => Promise.resolve(null),
      chainTime: () => Promise.resolve(100n),
      wrongKeyRejected: () => true,
      finalize: () => Promise.resolve(13268n),
    })
    const finished = await run(demos, 'd')
    await demos.act(finished.id, 'finalize')
    expect(receipts.list()[0]?.outcome).toEqual([
      'The seller sent the wrong key. Arc refused it.', 'Detail: Wrong key rejected by the contract.',
      "The seller didn't deliver. You got 0.013268 USDC back: your 0.001 USDC and your costs.",
      'Detail: The seller stayed silent. Its deposit paid 0.013268 USDC back: the 0.001 USDC price and 0.012268 USDC for the gas of the dispute.',
    ])
  })

  test('fraud ending (Seller F): the claim gas its answer repaid, then the price and the gas of the dispute, word for word', async () => {
    const lied = sealResponse('something else')
    const swapped: SealedBox = {
      ...box,
      ciphertext: lied.ciphertext,
      promise: { ...box.promise, keyHash: lied.keyHash, ciphertextHash: lied.ciphertextHash },
    }
    const { demos, receipts } = setup({
      readBox: () => Promise.resolve({ kind: 'box', box: swapped }),
      readKey: () => Promise.resolve({ key: lied.key, block: 8n }),
      claimGasRepaid: () => Promise.resolve({ amount: 5698n, sent: true }),
      prove: () => Promise.resolve(13268n),
    })
    const finished = await run(demos, 'f')
    expect(receipts.list()[0]?.outcome).toEqual(['The seller sent the key late and paid back the 0.005698 USDC it cost you to ask for it.', 'Detail: Claim gas repaid by the seller: 0.005698 USDC.'])
    await demos.act(finished.id, 'prove')
    expect(receipts.list()[0]?.outcome).toEqual([
      'The seller sent the key late and paid back the 0.005698 USDC it cost you to ask for it.', 'Detail: Claim gas repaid by the seller: 0.005698 USDC.',
      "The answer wasn't what the seller promised. You got 0.013268 USDC back: your 0.001 USDC and your costs.",
      "Detail: The answer did not match the seller's promise. Its deposit paid 0.013268 USDC back: the 0.001 USDC price and 0.012268 USDC for the gas of the dispute.",
    ])
  })

  test('a payout of the price or less names no gas', async () => {
    const { demos, receipts } = setup({
      readKey: () => Promise.resolve(null),
      chainTime: () => Promise.resolve(100n),
      finalize: () => Promise.resolve(700n),
    })
    const finished = await run(demos, 'e')
    await demos.act(finished.id, 'finalize')
    expect(receipts.list()[0]?.outcome).toEqual(["The seller didn't deliver. You got 0.0007 USDC back.", 'Detail: The seller stayed silent. Its deposit paid 0.0007 USDC back.'])
  })

  // The body of a receipt is read by people who have never held a wallet. The mechanism stays under Details.
  test('every ending reads without gas, contract or claim outside Details, and keeps them inside', async () => {
    const lied = sealResponse('something else')
    const swapped: SealedBox = { ...box, ciphertext: lied.ciphertext, promise: { ...box.promise, keyHash: lied.keyHash, ciphertextHash: lied.ciphertextHash } }
    const endings: string[][] = []
    const late = setup({ claimGasRepaid: () => Promise.resolve({ amount: 6949n, sent: true }) })
    await run(late.demos, 'a')
    endings.push(late.receipts.list()[0]?.outcome ?? [])
    const silent = setup({ readKey: () => Promise.resolve(null), chainTime: () => Promise.resolve(100n), wrongKeyRejected: () => true, finalize: () => Promise.resolve(13268n) })
    await silent.demos.act((await run(silent.demos, 'd')).id, 'finalize')
    endings.push(silent.receipts.list()[0]?.outcome ?? [])
    const fraud = setup({
      readBox: () => Promise.resolve({ kind: 'box', box: swapped }),
      readKey: () => Promise.resolve({ key: lied.key, block: 8n }),
      claimGasRepaid: () => Promise.resolve({ amount: 5698n, sent: false }),
      prove: () => Promise.resolve(13268n),
    })
    await fraud.demos.act((await run(fraud.demos, 'f')).id, 'prove')
    endings.push(fraud.receipts.list()[0]?.outcome ?? [])

    expect(endings.map((lines) => splitLines(lines).plain)).toEqual([
      ['Charged once. Key read from Arc.', 'The seller sent the key late and paid back the 0.006949 USDC it cost you to ask for it.', 'Circle record: 1 transfer for this payment.'],
      ['The seller sent the wrong key. Arc refused it.', "The seller didn't deliver. You got 0.013268 USDC back: your 0.001 USDC and your costs."],
      [
        'The seller sent the key late. The 0.005698 USDC it cost you to ask for it is waiting for you on Arc.',
        "The answer wasn't what the seller promised. You got 0.013268 USDC back: your 0.001 USDC and your costs.",
      ],
    ])
    for (const lines of endings) {
      const { plain, details } = splitLines(lines)
      for (const line of plain) expect(line).not.toMatch(/gas|contract|claim/i)
      expect(details.join(' ')).toMatch(/gas|contract/i)
    }
  })

  test('a button that does not apply is refused', async () => {
    const { demos } = setup()
    const finished = await run(demos, 'a')
    await expect(demos.act(finished.id, 'finalize')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  test('nothing the run shows carries the claim, the ciphertext or the key', async () => {
    const { demos } = setup({ readKey: () => Promise.resolve(null), chainTime: () => Promise.resolve(100n) })
    const finished = await run(demos, 'e')
    const text = JSON.stringify(finished)
    expect(text).not.toContain(CLAIM_ID)
    expect(text).not.toContain(sealed.ciphertext)
    expect(text).not.toContain(sealed.key)
  })
})
