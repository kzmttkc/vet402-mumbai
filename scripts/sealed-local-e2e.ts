// The whole sealed flow against the real contract on a local anvil, with real signatures.
// Only Gateway, the facilitator, Swarm and Arkiv are replaced. Nothing leaves this machine, and the keys are made fresh.
// Run: npx bun run scripts/sealed-local-e2e.ts
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { createPublicClient, createWalletClient, http, keccak256, parseAbi } from 'viem'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { ARC_GATEWAY_DOMAIN_NAME, ARC_GATEWAY_DOMAIN_VERSION, ARC_GATEWAY_WALLET, ARC_USDC } from '../src/existing/arc-gateway'
import { FROM_ARC, FROM_ARKIV, FROM_SWARM, openFromRecord, openSealedAnswer } from '../src/lib/openSealed'
import type { SwarmWire } from '../src/lib/swarmBox'
import { createEvidenceUploader } from '../server/swarm'
import type { PublicSealedFile } from '../src/lib/openSealed'
import { createDemoService } from '../server/demo'
import type { DemoPorts, DemoRunView, DemoSeller } from '../server/demo'
import { preparePayment } from '../server/gatewayPay'
import { createReceiptStore } from '../server/receiptStore'
import type { ReceiptRow } from '../server/receiptStore'
import {
  ANSWER_GAS,
  CLAIM_GAS,
  createSealedDelivery,
  createSealedPorts,
  createSealedScene,
  createSealer,
  FINALIZE_GAS,
  PROVE_GAS,
  revertNameOf,
  SEALED_ABI,
  WITHDRAW_GAS,
} from '../server/sealedDelivery'
import type { SealedNet } from '../server/sealedDelivery'
import { createSeller, DEMO_PRICE } from '../server/sellers'
import { formatUsdc } from '../src/onchain-money'
import type { SellerFacilitator } from '../server/sellers'
import { exportPublic } from './export-public'
import { runSetup, SELLER_DEPOSIT } from './sealed-setup'

const ROOT = path.resolve(import.meta.dirname, '..')
const MAX_EXPIRY = 3600n
const ANSWER_WINDOW = 8n
const COOLDOWN = MAX_EXPIRY + ANSWER_WINDOW
const DEAD: Address = '0x000000000000000000000000000000000000dEaD'
const USDC = ARC_USDC as Address
const ONE_ETH = '0xDE0B6B3A7640000'

/** The values contracts/README.md recommends for Arc testnet. */
const FOLLOW_UP_GAS = 230_000n
const MAX_GAS_PRICE = 100_000_000_000n
/** Gas is counted in 18 decimals, USDC in 6. */
const WEI_PER_UNIT = 10n ** 12n

/** Every value the contract's constructor may ask for, by name. Change the deployment here. */
const CONSTRUCTOR_VALUES: Record<string, unknown> = {
  maxExpiry: MAX_EXPIRY,
  answerWindow: ANSWER_WINDOW,
  cooldown: COOLDOWN,
  usdc: USDC,
  paymentDomainName: ARC_GATEWAY_DOMAIN_NAME,
  paymentDomainVersion: ARC_GATEWAY_DOMAIN_VERSION,
  paymentVerifyingContract: ARC_GATEWAY_WALLET,
  followUpGas: FOLLOW_UP_GAS,
  maxGasPrice: MAX_GAS_PRICE,
  paymentDomainSalt: `0x${'0'.repeat(64)}`,
}

/** Builds the arguments from the artifact, so a constructor with more inputs needs only a new value above. */
function constructorArgs(abi: unknown[]): unknown[] {
  const constructor = abi.find((item) => (item as { type?: string }).type === 'constructor') as
    | { inputs: { name: string }[] }
    | undefined
  return (constructor?.inputs ?? []).map(({ name }) => {
    const value = CONSTRUCTOR_VALUES[name.replace(/^_+|_+$/g, '')]
    if (value === undefined) throw new Error(`No value for the constructor input "${name}". Add it to CONSTRUCTOR_VALUES.`)
    return value
  })
}

let failures = 0
function check(scene: string, name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
  const e = JSON.stringify(expected, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${scene}: ${name}${ok ? '' : ` — got ${a}, wanted ${e}`}`)
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

async function main(tmp: string, anvil: { child: ChildProcess | null }) {
  // 1. Build into the temporary folder.
  const built = spawnSync('forge', ['build', '--out', path.join(tmp, 'out'), '--cache-path', path.join(tmp, 'cache')], { cwd: ROOT, encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`forge build failed:\n${built.stderr}`)
  const artifact = (file: string, name: string) =>
    JSON.parse(readFileSync(path.join(tmp, 'out', file, `${name}.json`), 'utf8')) as {
      abi: unknown[]
      bytecode: { object: Hex }
      deployedBytecode: { object: Hex }
    }
  const sealedArtifact = artifact('SealedDelivery.sol', 'SealedDelivery')
  const mockUsdc = artifact('SealedDelivery.Base.t.sol', 'MockUSDC')

  // 2. A chain with the real chain id, so the promise's domain is the same as it will be for real.
  const port = await freePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  anvil.child = spawn('anvil', ['--chain-id', String(arcTestnet.id), '--port', String(port), '--block-time', '1', '--silent'], { stdio: 'ignore' })
  const chain = { ...arcTestnet, rpcUrls: { default: { http: [rpcUrl] } } }
  const net: SealedNet = { chain, rpcUrl, pollingMs: 200 }
  const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 200 })
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId()
      break
    } catch (error) {
      if (i > 100) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const rpc = (method: string, params: unknown[]) => pub.request({ method, params } as never)

  // 3. The fake USDC (6 decimals, ERC-20) sits at the address the contract has fixed in its code.
  await rpc('anvil_setCode', [USDC, mockUsdc.deployedBytecode.object])

  const fresh = () => generatePrivateKey()
  const keys = { deployer: fresh(), buyer: fresh(), hold: fresh(), a: fresh(), d: fresh(), e: fresh(), f: fresh(), poor: fresh() }
  const addressOf = (key: Hex) => privateKeyToAccount(key).address
  for (const key of Object.values(keys)) await rpc('anvil_setBalance', [addressOf(key), ONE_ETH])

  const deployer = createWalletClient({ account: privateKeyToAccount(keys.deployer), chain, transport: http(rpcUrl), pollingInterval: 200 })
  const deployed = await pub.waitForTransactionReceipt({
    hash: await deployer.deployContract({
      abi: sealedArtifact.abi,
      bytecode: sealedArtifact.bytecode.object,
      args: constructorArgs(sealedArtifact.abi),
    } as never),
  })
  const address = deployed.contractAddress as Address
  const client = createSealedDelivery({ address, net })
  await pub.waitForTransactionReceipt({
    hash: await deployer.writeContract({
      address: USDC,
      abi: parseAbi(['function mint(address,uint256)']),
      functionName: 'mint',
      args: [addressOf(keys.buyer), 5_000_000n],
    }),
  })

  // 4. The setup script's own code, with its constants.
  const named = [
    { name: 'Seller A', key: keys.a },
    { name: 'Seller D', key: keys.d },
    { name: 'Seller E', key: keys.e },
    { name: 'Seller F', key: keys.f },
  ]
  await runSetup(client, keys.buyer, named, (line) => console.log(`      setup: ${line}`))
  for (const { name, key } of named) check('setup', `${name} deposit`, await client.deposits(addressOf(key)), SELLER_DEPOSIT)
  await runSetup(client, keys.buyer, named, () => {})
  check('setup', 'a second run sends nothing more', await client.deposits(addressOf(keys.a)), SELLER_DEPOSIT)

  // 5. Gateway and Circle's record, replaced. A nonce settles once, and the record is what was settled.
  const settled = new Map<string, { to: string; from: string; value: string }>()
  const settleCalls = { count: 0 }
  const authOf = (payload: unknown) =>
    (payload as { payload: { authorization: { nonce: string; to: string; from: string; value: string } } }).payload.authorization
  const facilitator: SellerFacilitator = {
    verify: (payload) =>
      Promise.resolve(settled.has(authOf(payload).nonce) ? { isValid: false, invalidReason: 'nonce used' } : { isValid: true }),
    settle: (payload) => {
      const auth = authOf(payload)
      settleCalls.count++
      settled.set(auth.nonce, auth)
      return Promise.resolve({ success: true, transaction: `local-${settleCalls.count}` })
    },
  }
  const confirm = (nonce: string, seller: string, payer: string) => {
    const record = settled.get(nonce)
    return !!record && record.to.toLowerCase() === seller.toLowerCase() && record.from.toLowerCase() === payer.toLowerCase()
  }

  // 6. The sellers, as the backend wires them.
  const switches = { dropKey: true, dropBoxOnce: false }
  const scene = createSealedScene({
    client,
    keys: { a: keys.a, d: keys.d, e: keys.e, f: keys.f },
    facilitator,
    dropKey: () => switches.dropKey,
    log: (message) => console.log(`      lookout: ${message}`),
  })
  const sellerA = createSeller({
    name: 'Seller A',
    payTo: addressOf(keys.a),
    declaresRecovery: true,
    facilitator,
    confirmCharged: (nonce, payer) => Promise.resolve(confirm(nonce, addressOf(keys.a), payer)),
    dropAfterSettle: () => {
      if (!switches.dropBoxOnce) return false
      switches.dropBoxOnce = false
      return true
    },
    sealing: scene.sellerASealing,
  })
  // A seller with no deposit behind it.
  const sellerPoor = createSeller({
    name: 'Seller G',
    payTo: addressOf(keys.poor),
    declaresRecovery: false,
    facilitator,
    confirmCharged: () => Promise.resolve(false),
    dropAfterSettle: () => false,
    sealing: { seal: createSealer(client, keys.poor), handsOverKey: () => false },
  })
  const app = express()
  const handlers: Record<string, ReturnType<typeof createSeller>> = {
    a: sellerA,
    d: scene.sellerD,
    e: scene.sellerE,
    f: scene.sellerF,
    g: sellerPoor,
  }
  for (const [id, handler] of Object.entries(handlers)) {
    app.get(`/sellers/${id}`, (req, res) => void handler(req, res))
    app.get(`/sellers/${id}/key`, (req, res) => void handler.key(req, res))
  }
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const stops = scene.watchers(sellerA.keyFor).map((watcher) => watcher.start(300))

  try {
    // Swarm stands in as a map from a content hash to the bytes, so the box never leaves this machine.
    const swarmKept = new Map<string, Uint8Array>()
    const localSwarm: SwarmWire = {
      upload(data) {
        const reference = keccak256(data).slice(2)
        swarmKept.set(reference, data)
        return Promise.resolve(reference)
      },
      download(reference) {
        const data = swarmKept.get(reference)
        return data ? Promise.resolve(data) : Promise.reject(new Error('not on the local Swarm'))
      },
    }

    // 7. The buyer's side: the demo service, signing for real with BatchEvmScheme.
    const dataDir = path.join(tmp, 'data')
    const receipts = createReceiptStore(dataDir)
    const holdAvailable = () => Promise.resolve(1_000_000n)
    const ports: DemoPorts = {
      holdAvailable,
      growHold: () => Promise.resolve(),
      async prepare(url) {
        const challenge = await preparePayment({ holdKey: keys.hold, holdAvailable }, { url, method: 'GET' }, DEMO_PRICE)
        if (challenge.kind === 'free') throw new Error('The seller did not ask for a payment')
        return challenge.payment
      },
      confirmOnePayment: (nonce, expected) => Promise.resolve(confirm(nonce, expected.seller, expected.payer)),
      countPayments: () => Promise.resolve(0),
      sealed: createSealedPorts({ client, holdKey: keys.hold, buyerKey: keys.buyer, rejected: scene.rejected }),
      sealedPollMs: 300,
      evidence: createEvidenceUploader({ swarm: localSwarm, contract: address, chainId: chain.id }),
    }
    const seller = (id: string, name: string, key: Hex): DemoSeller => ({ name, url: `${base}/sellers/${id}`, address: addressOf(key) })
    const sellers = {
      a: seller('a', 'Seller A', keys.a),
      b: seller('a', 'Seller A', keys.a), // Seller B is untouched and is not part of this run.
      d: seller('d', 'Seller D', keys.d),
      e: seller('e', 'Seller E', keys.e),
      f: seller('f', 'Seller F', keys.f),
    }
    const demos = createDemoService(ports, sellers, receipts)
    const poorDemos = createDemoService(ports, { ...sellers, d: seller('g', 'Seller G', keys.poor) }, createReceiptStore(path.join(tmp, 'data-poor')))

    const hold = addressOf(keys.hold)
    // What the buyer's transactions cost, from their receipts, in gas wei.
    const costOf = async (hash: Hex) => {
      const r = await pub.getTransactionReceipt({ hash })
      return { wei: r.gasUsed * r.effectiveGasPrice, gas: r.gasUsed, price: r.effectiveGasPrice }
    }
    const claimTxOf = async (claimId: Hex) => {
      const log = (await client.claimLogs(0n)).find((l) => l.claimId.toLowerCase() === claimId.toLowerCase())
      if (!log) throw new Error('No claim on the chain')
      return log.transactionHash
    }
    const eventTx = async (eventName: 'Silent' | 'Fraud' | 'ClaimableWithdrawn', fromBlock: bigint, claimId?: Hex) => {
      const logs = await pub.getContractEvents({ address, abi: SEALED_ABI, eventName, fromBlock })
      const log = claimId ? logs.find((l) => (l.args as { claimId?: Hex }).claimId?.toLowerCase() === claimId.toLowerCase()) : logs[logs.length - 1]
      if (!log) throw new Error(`No ${eventName} on the chain`)
      return log.transactionHash
    }
    // A contract with flushBurn holds the burned half back until someone sends it on.
    const holdsBurnBack = sealedArtifact.abi.some((item) => (item as { name?: string }).name === 'flushBurn')
    const runScene = async (service: typeof demos, kind: 'a' | 'd' | 'e' | 'f'): Promise<{ run: DemoRunView; row: ReceiptRow | undefined; store: ReceiptRow[] }> => {
      const started = service.start(kind)
      await service.settled(started.id)
      const run = service.get(started.id)
      if (!run) throw new Error('The run is gone')
      const store = receipts.list()
      return { run, row: store[0], store }
    }
    const names = (run: DemoRunView) => run.steps.map((step) => step.name)
    const stepsLine = (run: DemoRunView) => run.steps.map((s) => `${s.name} ${(s.atMs / 1000).toFixed(1)}s`).join(' > ')

    // Seller A, the key's connection drops.
    const before = settleCalls.count
    const holdStart = await client.usdcBalance(hold)
    const a = await runScene(demos, 'a')
    console.log(`      A: ${stepsLine(a.run)}`)
    check('A key from the chain', 'state', a.run.state, 'done')
    check('A key from the chain', 'steps', names(a.run), ['hold', 'payment', 'waiting', 'waiting', 'fetching again', 'connection dropped', 'claim', 'key on chain', 'opened', 'delivered'])
    check('A key from the chain', 'received once', a.row?.timesReceived, 1)
    check('A key from the chain', 'settled once', settleCalls.count - before, 1)
    check('A key from the chain', 'nothing to press', a.run.action, null)
    const holdTopUp = (await client.usdcBalance(hold)) - holdStart
    check('A key from the chain', 'the buyer added gas to the hold', holdTopUp > 0n, true)
    const aClaimId = a.row?.sealed?.claimId as Hex
    const aRefund = await client.gasRefundOf(aClaimId)
    check('A key from the chain', 'receipt', a.row?.outcome, ['Charged once. Key read from Arc.', `The seller sent the key late and paid back the ${formatUsdc(aRefund)} USDC it cost you to ask for it.`, `Detail: Claim gas repaid by the seller: ${formatUsdc(aRefund)} USDC.`, 'Circle record: 1 transfer for this payment.'])
    check('A key from the chain', 'the deposit paid the claim gas and nothing else', await client.deposits(addressOf(keys.a)), SELLER_DEPOSIT - aRefund)
    const aRepaid = await pub.getContractEvents({ address, abi: SEALED_ABI, eventName: 'ClaimGasRepaid', args: { claimId: aClaimId }, fromBlock: 0n })
    check('A key from the chain', 'the answer sent the claim gas to the buyer', aRepaid.map((l) => [l.args.buyer, l.args.amount, l.args.sent]), [[hold, aRefund, true]])
    const aClaimCost = await costOf(await claimTxOf(aClaimId))
    const aNet = aRefund * WEI_PER_UNIT - aClaimCost.wei
    console.log(`      A: claim ${aClaimCost.gas} gas at ${aClaimCost.price} wei, repaid ${aRefund} units, buyer net ${aNet} wei`)
    check('A key from the chain', 'the buyer gets its claim gas back', aNet >= 0n, true)
    check('A key from the chain', 'and no more than 5 % on top', aNet * 100n <= aClaimCost.wei * 5n, true)
    const maxCost = await client.maxDisputeCost()
    const free = (await client.deposits(addressOf(keys.a))) / 2n - maxCost
    check('A key from the chain', 'coverage came back', [await client.coverageFor(addressOf(keys.a), free), await client.coverageFor(addressOf(keys.a), free + 1n)], [true, false])
    let kept = 'no revert'
    try {
      await client.prove(keys.hold, aClaimId, a.row?.sealed?.ciphertext as Hex, (await client.readKeyRevealed(aClaimId, 0n))?.key as Hex)
    } catch (error) {
      kept = revertNameOf(error) ?? 'other'
    }
    check('A key from the chain', 'prove on a kept promise reverts', kept, 'PromiseKept')

    // Seller A, the box's connection drops first. The same-payment path gets it, then the key comes from the chain.
    switches.dropBoxOnce = true
    const beforeBox = settleCalls.count
    const box = await runScene(demos, 'a')
    console.log(`      A box lost: ${stepsLine(box.run)}`)
    check('A box lost, then key', 'steps', names(box.run), ['hold', 'payment', 'waiting', 'connection dropped', 'fetching again', 'waiting', 'fetching again', 'connection dropped', 'claim', 'key on chain', 'opened', 'delivered'])
    const boxRefund = await client.gasRefundOf(box.row?.sealed?.claimId as Hex)
    check('A box lost, then key', 'receipt', box.row?.outcome, ['Charged once. Key read from Arc.', `The seller sent the key late and paid back the ${formatUsdc(boxRefund)} USDC it cost you to ask for it.`, `Detail: Claim gas repaid by the seller: ${formatUsdc(boxRefund)} USDC.`, 'Circle record: 1 transfer for this payment.'])
    check('A box lost, then key', 'settled once', settleCalls.count - beforeBox, 1)

    // Seller A with the switch off: the key comes on its own request and nothing touches the chain.
    switches.dropKey = false
    const beforeClaims = await client.claimLogs(0n)
    const off = await runScene(demos, 'a')
    console.log(`      A switch off: ${stepsLine(off.run)}`)
    switches.dropKey = true
    check('A switch off', 'steps', names(off.run), ['hold', 'payment', 'waiting', 'waiting', 'opened', 'delivered'])
    check('A switch off', 'receipt', off.row?.outcome, ['Charged once. Delivered.'])
    const afterClaims = await client.claimLogs(0n)
    check('A switch off', 'no claim sent', afterClaims.length, beforeClaims.length)

    // A seller with too little deposit is treated like Seller B: no claim, no second try.
    const poor = await (async () => {
      const started = poorDemos.start('d')
      await poorDemos.settled(started.id)
      return poorDemos.get(started.id) as DemoRunView
    })()
    console.log(`      no deposit: ${stepsLine(poor)}`)
    const poorRow = createReceiptStore(path.join(tmp, 'data-poor')).list()[0]
    check('no deposit', 'receipt', poorRow?.outcome, ['Charged once. Nothing delivered. No second charge.'])
    check('no deposit', 'no claim step', names(poor).includes('claim'), false)

    const silentScene = async (label: string, kind: 'd' | 'e', key: Hex, first: string[]) => {
      const depositBefore = await client.deposits(addressOf(key))
      const deadBefore = await client.usdcBalance(DEAD)
      const claimableBefore = await client.claimable(hold)
      const { run, row } = await runScene(demos, kind)
      console.log(`      ${label}: ${stepsLine(run)}`)
      check(label, 'stops at the button', run.action, 'finalize')
      check(label, 'receipt before the button', row?.outcome, first)
      // A silent claim has no sealed record on the receipt. Its claim is the seller's latest on the chain.
      const sellerClaims = await client.readClaimed(addressOf(key), 0n, await client.latestBlock())
      const claimId = sellerClaims[sellerClaims.length - 1]?.claimId as Hex
      const owed = (await client.liabilityOf(claimId)) / 2n
      const fromBlock = await client.latestBlock()
      const pressed = await demos.act(run.id, 'finalize')
      // The button already sent the burned half on, and the check below reads that.
      const after = receipts.list().find((r) => r.id === row?.id)
      check(label, 'receipt', after?.outcome, [
        ...first,
        `The seller didn't deliver. You got ${formatUsdc(owed)} USDC back: your ${formatUsdc(DEMO_PRICE)} USDC and your costs.`,
        `Detail: The seller stayed silent. Its deposit paid ${formatUsdc(owed)} USDC back: the ${formatUsdc(DEMO_PRICE)} USDC price and ${formatUsdc(owed - DEMO_PRICE)} USDC for the gas of the dispute.`,
      ])
      check(label, 'the buyer is credited the price and its gas', (await client.claimable(hold)) - claimableBefore, owed)
      check(label, 'the same is burned', (await client.usdcBalance(DEAD)) - deadBefore, owed)
      check(label, 'the deposit pays twice that', depositBefore - (await client.deposits(addressOf(key))), 2n * owed)
      check(label, 'next button', pressed.action, 'withdraw')
      const holdBefore = await client.usdcBalance(hold)
      const withdrawn = await demos.act(run.id, 'withdraw')
      const holdAfter = await client.usdcBalance(hold)
      check(label, 'back in the hold', holdAfter - holdBefore >= owed, true)
      check(label, 'nothing left to take', await client.claimable(hold), 0n)
      check(label, 'no more buttons', withdrawn.action, null)
      const costs = await Promise.all((await Promise.all([claimTxOf(claimId), eventTx('Silent', fromBlock, claimId), eventTx('ClaimableWithdrawn', fromBlock)])).map(costOf))
      const net = owed * WEI_PER_UNIT - DEMO_PRICE * WEI_PER_UNIT - costs.reduce((sum: bigint, c) => sum + c.wei, 0n)
      console.log(`      ${label}: claim ${costs[0]!.gas}, finalize ${costs[1]!.gas}, withdraw ${costs[2]!.gas} gas, buyer net ${net} wei`)
      check(label, 'the buyer gets the price and all three transactions back', net >= 0n, true)
    }

    await silentScene('D wrong key, then silent', 'd', keys.d, ['The seller sent the wrong key. Arc refused it.', 'Detail: Wrong key rejected by the contract.'])
    await silentScene('E silent', 'e', keys.e, [])

    // Seller F swaps the answer, and answers the claim with the right key.
    const fDeposit = await client.deposits(addressOf(keys.f))
    const f = await runScene(demos, 'f')
    console.log(`      F: ${stepsLine(f.run)}`)
    check('F swapped answer', 'steps end at opened', names(f.run).slice(-3), ['claim', 'key on chain', 'opened'])
    check('F swapped answer', 'stops at the button', f.run.action, 'prove')
    const fClaimId = f.row?.sealed?.claimId as Hex
    const fOwed = (await client.liabilityOf(fClaimId)) / 2n
    const fRefund = await client.gasRefundOf(fClaimId)
    const fFrom = await client.latestBlock()
    const proved = await demos.act(f.run.id, 'prove')
    const fRow = receipts.list().find((r) => r.id === f.row?.id)
    check('F swapped answer', 'receipt', fRow?.outcome, [
      `The seller sent the key late and paid back the ${formatUsdc(fRefund)} USDC it cost you to ask for it.`,
      `Detail: Claim gas repaid by the seller: ${formatUsdc(fRefund)} USDC.`,
      `The answer wasn't what the seller promised. You got ${formatUsdc(fOwed)} USDC back: your ${formatUsdc(DEMO_PRICE)} USDC and your costs.`,
      `Detail: The answer did not match the seller's promise. Its deposit paid ${formatUsdc(fOwed)} USDC back: the ${formatUsdc(DEMO_PRICE)} USDC price and ${formatUsdc(fOwed - DEMO_PRICE)} USDC for the gas of the dispute.`,
    ])
    check('F swapped answer', 'FRAUD on the contract', await pub.readContract({ address, abi: SEALED_ABI, functionName: 'fraudCount', args: [addressOf(keys.f)] }), 1n)
    check('F swapped answer', 'the deposit pays the claim gas, then twice the credit', fDeposit - (await client.deposits(addressOf(keys.f))), fRefund + 2n * fOwed)
    check('F swapped answer', 'the buyer is credited the price and its gas', await client.claimable(hold), fOwed)
    check('F swapped answer', 'next button', proved.action, 'withdraw')
    await demos.act(f.run.id, 'withdraw')
    check('F swapped answer', 'nothing left to take', await client.claimable(hold), 0n)
    const fCosts = await Promise.all((await Promise.all([claimTxOf(fClaimId), eventTx('Fraud', fFrom, fClaimId), eventTx('ClaimableWithdrawn', fFrom)])).map(costOf))
    const fNet = (fRefund + fOwed - DEMO_PRICE) * WEI_PER_UNIT - fCosts.reduce((sum: bigint, c) => sum + c.wei, 0n)
    console.log(`      F: claim ${fCosts[0]!.gas}, prove ${fCosts[1]!.gas}, withdraw ${fCosts[2]!.gas} gas, buyer net ${fNet} wei`)
    check('F swapped answer', 'the buyer gets the price and all three transactions back', fNet >= 0n, true)

    // A button pressed twice does nothing the second time.
    let again = 'no error'
    try {
      await demos.act(f.run.id, 'withdraw')
    } catch (error) {
      again = (error as { code?: string }).code ?? 'other'
    }
    check('buttons', 'a second press is refused', again, 'UNAVAILABLE')

    // The published screen's own code: the exported file, the key straight from the node, no backend.
    const outDir = path.join(tmp, 'static')
    exportPublic({ dataDir, outDir, sealedContract: address })
    const file = JSON.parse(readFileSync(path.join(outDir, 'sealed.json'), 'utf8')) as PublicSealedFile
    check('published screen', 'file holds no key', Object.keys(file.answers[0] ?? {}).sort(), ['ciphertext', 'claimId', 'keyBlock', 'plaintextHash', 'ref', 'sellerName'])
    const opened = await Promise.all(file.answers.map(async (answer) => ({ answer, result: await openSealedAnswer(answer, address, { rpcUrl }) })))
    const aOpen = opened.filter((o) => o.answer.sellerName === 'Seller A')
    const fOpen = opened.filter((o) => o.answer.sellerName === 'Seller F')
    check('published screen', 'Seller A answers found', aOpen.length, 2)
    for (const { result } of aOpen) check('published screen', 'Seller A opens', result.line, "Matches the seller's promise.")
    check('published screen', 'Seller A text', aOpen[0]?.result.ok ? aOpen[0].result.text : null, JSON.stringify({ seller: 'Seller A', answer: 'Here is the answer you paid for.' }))
    check('published screen', 'Seller F opens and does not match', fOpen[0]?.result.line, "Does not match the seller's promise.")

    // The same answers through the record: Arkiv's evidence (the receipt rows stand in), the box from Swarm, the key from the chain.
    const rows = receipts.list()
    const readEvidence = (claimId: string) =>
      Promise.resolve(rows.find((r) => r.evidence?.claimId.toLowerCase() === claimId.toLowerCase())?.evidence?.swarmRef ?? null)
    const recorded = await Promise.all(
      file.answers.map(async (answer) => ({
        answer,
        result: await openFromRecord({ ...answer, ciphertext: '0x' }, address, { readEvidence, downloadBox: localSwarm.download }, { rpcUrl }),
      })),
    )
    check('swarm', 'every sealed answer has its box on Swarm', recorded.map((o) => o.result.read), file.answers.map(() => [FROM_ARKIV, FROM_SWARM, FROM_ARC]))
    check('swarm', 'Seller A opens from Swarm', recorded.filter((o) => o.answer.sellerName === 'Seller A').map((o) => o.result.line), ["Matches the seller's promise.", "Matches the seller's promise."])
    check('swarm', 'Seller F opens from Swarm and does not match', recorded.find((o) => o.answer.sellerName === 'Seller F')?.result.line, "Does not match the seller's promise.")
    const silent = rows.filter((r) => r.sellerName === 'Seller E' && r.evidence)
    check('swarm', 'a claim with no key still has its box on Swarm', silent.length > 0, true)

    // The gas bounds in the code are real.
    const gasOf = async (eventName: 'Claimed' | 'KeyRevealed' | 'Silent' | 'Fraud' | 'ClaimableWithdrawn') => {
      const logs =
        eventName === 'Claimed'
          ? await client.claimLogs(0n)
          : await pub.getContractEvents({ address, abi: SEALED_ABI, eventName, fromBlock: 0n })
      const used = await Promise.all(logs.map(async (log) => (await pub.getTransactionReceipt({ hash: log.transactionHash })).gasUsed))
      return used.reduce((max, gas) => (gas > max ? gas : max), 0n)
    }
    const bounds: [string, 'Claimed' | 'KeyRevealed' | 'Silent' | 'Fraud' | 'ClaimableWithdrawn', bigint][] = [
      ['claim', 'Claimed', CLAIM_GAS],
      ['answer', 'KeyRevealed', ANSWER_GAS],
      ['finalize', 'Silent', FINALIZE_GAS],
      ['prove', 'Fraud', PROVE_GAS],
      ['withdrawClaimable', 'ClaimableWithdrawn', WITHDRAW_GAS],
    ]
    for (const [name, event, bound] of bounds) {
      const used = await gasOf(event)
      console.log(`      gas ${name}: used ${used}, bound ${bound}`)
      check('gas', `${name} within its bound`, used > 0n && used <= bound, true)
    }
  } finally {
    for (const stop of stops) stop()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'sealed-e2e-'))
const anvil: { child: ChildProcess | null } = { child: null }
let crashed = false
try {
  await main(tmp, anvil)
} catch (error) {
  crashed = true
  console.error('The run stopped:', error instanceof Error ? error.message : error)
} finally {
  if (anvil.child?.pid) {
    const { pid } = anvil.child
    anvil.child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 200))
    console.log(`anvil ${pid} stopped: ${anvil.child.killed}`)
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log(`temporary folder removed: ${!existsSync(tmp)}`)
}
console.log(crashed || failures > 0 ? `RESULT: ${crashed ? 'stopped early' : `${failures} failed`}` : 'RESULT: all scenes as expected')
process.exit(crashed || failures > 0 ? 1 : 0)
