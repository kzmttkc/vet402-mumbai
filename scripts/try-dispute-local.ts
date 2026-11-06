// The try function's own handler, end to end, against the real contract on a local anvil, with real signatures.
// Only Gateway, the facilitator and Circle's record are replaced. Nothing leaves this machine, and the keys are made fresh.
// The same way as scripts/sealed-local-e2e.ts. Run: npx bun run scripts/try-dispute-local.ts
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { ARC_GATEWAY_DOMAIN_NAME, ARC_GATEWAY_DOMAIN_VERSION, ARC_GATEWAY_WALLET, ARC_USDC } from '../src/existing/arc-gateway'
import { MATCHES_PROMISE, openSealedAnswer } from '../src/lib/openSealed'
import { formatUsdc } from '../src/onchain-money'
import { preparePayment } from '../server/gatewayPay'
import { createSealedDelivery } from '../server/sealedDelivery'
import type { SealedNet } from '../server/sealedDelivery'
import { DEMO_PRICE } from '../server/sellers'
import type { SellerFacilitator } from '../server/sellers'
import { createTryDispute, createTryHandler } from '../server/tryDispute'
import type { TryEvent } from '../server/tryDispute'
import { createTryPorts } from '../server/tryDisputeWire'
import { runSetup } from './sealed-setup'

const ROOT = path.resolve(import.meta.dirname, '..')
const MAX_EXPIRY = 3600n
const ANSWER_WINDOW = 60n
const USDC = ARC_USDC as Address
const ONE_ETH = '0xDE0B6B3A7640000'

const CONSTRUCTOR_VALUES: Record<string, unknown> = {
  maxExpiry: MAX_EXPIRY,
  answerWindow: ANSWER_WINDOW,
  cooldown: MAX_EXPIRY + ANSWER_WINDOW,
  usdc: USDC,
  paymentDomainName: ARC_GATEWAY_DOMAIN_NAME,
  paymentDomainVersion: ARC_GATEWAY_DOMAIN_VERSION,
  paymentVerifyingContract: ARC_GATEWAY_WALLET,
  followUpGas: 230_000n,
  maxGasPrice: 100_000_000_000n,
  paymentDomainSalt: `0x${'0'.repeat(64)}`,
}

function constructorArgs(abi: unknown[]): unknown[] {
  const constructor = abi.find((item) => (item as { type?: string }).type === 'constructor') as { inputs: { name: string }[] } | undefined
  return (constructor?.inputs ?? []).map(({ name }) => {
    const value = CONSTRUCTOR_VALUES[name.replace(/^_+|_+$/g, '')]
    if (value === undefined) throw new Error(`No value for the constructor input "${name}".`)
    return value
  })
}

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
  const e = JSON.stringify(expected, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : `: got ${a}, wanted ${e}`}`)
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

async function readStream(res: Response): Promise<TryEvent[]> {
  return (await res.text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TryEvent)
}

async function main(tmp: string, anvil: { child: ChildProcess | null }) {
  const built = spawnSync('forge', ['build', '--out', path.join(tmp, 'out'), '--cache-path', path.join(tmp, 'cache')], { cwd: ROOT, encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`forge build failed:\n${built.stderr}`)
  const artifact = (file: string, name: string) =>
    JSON.parse(readFileSync(path.join(tmp, 'out', file, `${name}.json`), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex }; deployedBytecode: { object: Hex } }
  const sealedArtifact = artifact('SealedDelivery.sol', 'SealedDelivery')
  const mockUsdc = artifact('SealedDelivery.Base.t.sol', 'MockUSDC')

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
  await rpc('anvil_setCode', [USDC, mockUsdc.deployedBytecode.object])

  const keys = { deployer: generatePrivateKey(), buyer: generatePrivateKey(), hold: generatePrivateKey(), seller: generatePrivateKey() }
  const addressOf = (key: Hex) => privateKeyToAccount(key).address
  for (const key of Object.values(keys)) await rpc('anvil_setBalance', [addressOf(key), ONE_ETH])

  const deployer = createWalletClient({ account: privateKeyToAccount(keys.deployer), chain, transport: http(rpcUrl), pollingInterval: 200 })
  const deployed = await pub.waitForTransactionReceipt({
    hash: await deployer.deployContract({ abi: sealedArtifact.abi, bytecode: sealedArtifact.bytecode.object, args: constructorArgs(sealedArtifact.abi) }),
  })
  const address = deployed.contractAddress as Address
  const client = createSealedDelivery({ address, net })
  await pub.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: USDC, abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [addressOf(keys.buyer), 5_000_000n] }),
  })
  await runSetup(client, keys.buyer, [{ name: 'Seller A', key: keys.seller }], (line) => console.log(`      setup: ${line}`))

  // Gateway and Circle's record, replaced. A nonce settles once, and the record is what was settled, with its time.
  const settled = new Map<string, { to: string; from: string; at: number }>()
  const authOf = (payload: unknown) => (payload as { payload: { authorization: { nonce: string; to: string; from: string } } }).payload.authorization
  const facilitator: SellerFacilitator = {
    verify: (payload) => Promise.resolve(settled.has(authOf(payload).nonce) ? { isValid: false, invalidReason: 'nonce used' } : { isValid: true }),
    settle: (payload) => {
      const auth = authOf(payload)
      settled.set(auth.nonce, { to: auth.to, from: auth.from, at: Date.now() })
      return Promise.resolve({ success: true, transaction: `local-${settled.size}` })
    },
  }
  const confirm = (nonce: string, seller: string, payer: string) => {
    const record = settled.get(nonce)
    return !!record && record.to.toLowerCase() === seller.toLowerCase() && record.from.toLowerCase() === payer.toLowerCase()
  }
  const holdAvailable = () => Promise.resolve(1_000_000n)

  const ports = createTryPorts({
    sealedAddress: address,
    net,
    keys: { hold: keys.hold, seller: keys.seller, buyer: keys.buyer },
    facilitator,
    demo: {
      holdAvailable,
      growHold: () => Promise.resolve(),
      async prepare(url) {
        const challenge = await preparePayment({ holdKey: keys.hold, holdAvailable }, { url, method: 'GET' }, DEMO_PRICE)
        if (challenge.kind === 'free') throw new Error('The seller did not ask for a payment')
        return challenge.payment
      },
      confirmOnePayment: (nonce, expected) => Promise.resolve(confirm(nonce, expected.seller, expected.payer)),
      countPayments: () => Promise.resolve(0),
    },
    confirmCharged: (nonce, payer) => Promise.resolve(confirm(nonce, addressOf(keys.seller), payer)),
    recentPayments: (hold, seller) =>
      Promise.resolve(
        [...settled.values()]
          .filter((r) => r.from.toLowerCase() === hold.toLowerCase() && r.to.toLowerCase() === seller.toLowerCase())
          .map((r) => r.at)
          .reverse(),
      ),
    watchMs: 300,
    pollMs: 300,
    log: (message) => console.log(`      log: ${message}`),
  })
  const tries = createTryDispute(ports, { dailyLimit: 40 })
  const handle = createTryHandler(() => tries)
  const press = (ip: string) => handle(new Request('http://localhost/api/try-dispute', { method: 'POST', headers: { 'x-forwarded-for': ip } }))

  // One press, through the function's own handler.
  const started = Date.now()
  const res = await press('1.2.3.4')
  check('the press is accepted', res.status, 200)
  const events = await readStream(res)
  const steps = events.flatMap((e) => (e.type === 'step' ? [e] : []))
  console.log(`      ${steps.map((s) => `${s.name} ${(s.atMs / 1000).toFixed(1)}s`).join(' > ')}`)
  console.log(`      took ${((Date.now() - started) / 1000).toFixed(1)} s`)
  check('steps', steps.map((s) => s.name), ['hold', 'payment', 'waiting', 'waiting', 'fetching again', 'connection dropped', 'claim', 'key on chain', 'opened', 'delivered'])
  const result = events.find((e) => e.type === 'result')
  check('result ok', result?.type === 'result' && result.ok, true)
  if (result?.type !== 'result' || !result.ok) throw new Error(`The try did not finish: ${JSON.stringify(result)}`)
  const repaid = await client.gasRefundOf(result.box.claimId as Hex)
  check('receipt lines', result.lines, ['Charged once. Key read from Arc.', `The seller sent the key late and paid back the ${formatUsdc(repaid)} USDC it cost you to ask for it.`, `Detail: Claim gas repaid by the seller: ${formatUsdc(repaid)} USDC.`, 'Circle record: 1 transfer for this payment.'])
  check('settled once', settled.size, 1)

  // The two links point at real transactions: the claim from the hold, the answer from the seller.
  const claimTx = await pub.getTransaction({ hash: result.claimTx as Hex })
  const answerTx = await pub.getTransaction({ hash: result.answerTx as Hex })
  check('claim sent by the hold', claimTx.from.toLowerCase(), addressOf(keys.hold).toLowerCase())
  check('answer sent by the seller', answerTx.from.toLowerCase(), addressOf(keys.seller).toLowerCase())
  check('both go to the contract', [claimTx.to?.toLowerCase(), answerTx.to?.toLowerCase()], [address.toLowerCase(), address.toLowerCase()])

  // The browser's own code opens the box with the key it reads from the chain.
  const opened = await openSealedAnswer({ ref: 'try', sellerName: 'Seller A', ...result.box }, result.box.contract, { rpcUrl })
  check('the browser opens the box', opened.line, MATCHES_PROMISE)
  check('the answer', opened.ok ? opened.text : null, JSON.stringify({ seller: 'Seller A', answer: 'Here is the answer you paid for.' }))
  check('the stream holds no private key', [keys.hold, keys.seller, keys.buyer].some((k) => JSON.stringify(events).includes(k.slice(2))), false)

  // The guards, on the same handler.
  const again = await press('1.2.3.4')
  check('same address again within two minutes', [again.status, ((await again.json()) as { code: string }).code], [429, 'RATE'])
  const other = await press('5.6.7.8')
  check("another address while Circle's record shows a payment moments ago", [other.status, ((await other.json()) as { code: string }).code], [409, 'BUSY'])
  check('still settled once', settled.size, 1)
}

const tmp = mkdtempSync(path.join(tmpdir(), 'try-dispute-'))
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
console.log(crashed || failures > 0 ? `RESULT: ${crashed ? 'stopped early' : `${failures} failed`}` : 'RESULT: the try ran end to end')
process.exit(crashed || failures > 0 ? 1 : 0)
