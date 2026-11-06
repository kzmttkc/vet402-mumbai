// Runs packages/sealed-delivery/examples end to end against the real contract on a local anvil.
// Only Gateway is replaced, by a facilitator that checks the buyer's signature. Keys are made fresh,
// and nothing leaves this machine. Run: npx bun run scripts/sdk-example-local.ts
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { buy } from '../packages/sealed-delivery/examples/buyer'
import { createLocalFacilitator, createLocalPayer } from '../packages/sealed-delivery/examples/localPayment'
import { createSellerApp } from '../packages/sealed-delivery/examples/seller'
import { createSealedChain } from '../packages/sealed-delivery/src/index'
import type { PaymentRequirement } from '../packages/sealed-delivery/src/index'

const ROOT = path.resolve(import.meta.dirname, '..')
const PRICE = 1_000n
/** The values contracts/README.md recommends for Arc testnet. */
const FOLLOW_UP_GAS = 230_000n
const MAX_GAS_PRICE = 100_000_000_000n
/** Covers four claims at the cap: each needs 2 * (price + MAX_DISPUTE_COST), about 0.112 USDC. */
const DEPOSIT = 500_000n
const GATEWAY: Address = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
const ONE_ETH = '0xDE0B6B3A7640000'

let failures = 0
function check(scene: string, name: string, actual: unknown, expected: unknown) {
  const show = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))
  const ok = show(actual) === show(expected)
  if (!ok) failures++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${scene}: ${name}${ok ? '' : ` (got ${show(actual)}, wanted ${show(expected)})`}`)
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

const listen = (app: express.Express) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })

async function main(tmp: string, anvil: { child: ChildProcess | null }, cleanups: (() => void)[]) {
  const built = spawnSync('forge', ['build', '--out', path.join(tmp, 'out'), '--cache-path', path.join(tmp, 'cache')], { cwd: ROOT, encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`forge build failed:\n${built.stderr}`)
  const artifact = (file: string, name: string) =>
    JSON.parse(readFileSync(path.join(tmp, 'out', file, `${name}.json`), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } }

  const port = await freePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  anvil.child = spawn('anvil', ['--port', String(port), '--block-time', '1', '--silent'], { stdio: 'ignore' })
  const chain = { ...foundry, rpcUrls: { default: { http: [rpcUrl] } } }
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

  const keys = { deployer: generatePrivateKey(), seller: generatePrivateKey(), buyer: generatePrivateKey(), bare: generatePrivateKey() }
  const addressOf = (key: Hex) => privateKeyToAccount(key).address
  for (const key of Object.values(keys)) await pub.request({ method: 'anvil_setBalance', params: [addressOf(key), ONE_ETH] } as never)
  const deployer = createWalletClient({ account: privateKeyToAccount(keys.deployer), chain, transport: http(rpcUrl), pollingInterval: 200 })
  const deploy = async (name: [string, string], args: unknown[]) => {
    const a = artifact(...name)
    const receipt = await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }) })
    return receipt.contractAddress as Address
  }

  // Any 6-decimal ERC-20 and any EIP-712 payment domain whose version is not "2" without a salt.
  const usdc = await deploy(['SealedDelivery.Base.t.sol', 'MockUSDC'], [])
  const contract = await deploy(['SealedDelivery.sol', 'SealedDelivery'], [3600n, 8n, 3608n, usdc, 'GatewayWalletBatched', '1', GATEWAY, FOLLOW_UP_GAS, MAX_GAS_PRICE, `0x${'0'.repeat(64)}`])
  await pub.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: usdc, abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [addressOf(keys.seller), DEPOSIT] }),
  })
  const sealedChain = createSealedChain({ contract, rpcUrl, pollingMs: 200 })
  await sealedChain.deposit(keys.seller, DEPOSIT)
  check('setup', 'seller deposit', await sealedChain.deposits(addressOf(keys.seller)), DEPOSIT)

  const domain = { name: 'GatewayWalletBatched', version: '1', chainId: chain.id, verifyingContract: GATEWAY }
  const { facilitator, settled } = createLocalFacilitator(domain)
  const pay = createLocalPayer(keys.buyer, domain)
  const accepts = (payTo: Address): PaymentRequirement => ({
    scheme: 'exact',
    network: `eip155:${chain.id}`,
    asset: usdc,
    amount: PRICE.toString(),
    payTo,
    extra: { name: domain.name, version: domain.version, verifyingContract: GATEWAY },
  })

  /** Serves the example seller. `dropKey` closes the connection on the key route, as a seller that never hands it over. */
  async function serve(sellerKey: Hex, { watch, dropKey }: { watch: boolean; dropKey: boolean }) {
    const seller = createSellerApp({ contract, sellerKey, rpcUrl, facilitator, accepts: accepts(addressOf(sellerKey)), watch })
    const outer = express()
    if (dropKey) outer.get('/forecast/key', (req) => req.socket.destroy())
    outer.use(seller.app)
    const { server, url } = await listen(outer)
    const stop = () => {
      seller.close()
      server.closeAllConnections?.()
      server.close()
    }
    cleanups.push(stop)
    return { url: `${url}/forecast`, stop }
  }
  const buyer = (url: string) => buy({ url, contract, rpcUrl, buyerKey: keys.buyer, pay })
  const ANSWER = JSON.stringify({ city: 'Mumbai', forecast: 'Sunny, 31 C' })

  // 1. The key comes over HTTP. The contract never hears about it.
  {
    const s = await serve(keys.seller, { watch: true, dropKey: false })
    const r = await buyer(s.url)
    check('key over HTTP', 'status', r.status, 'opened')
    if (r.status !== 'not covered') {
      check('key over HTTP', 'answer', r.text, ANSWER)
      check('key over HTTP', 'key came from the key route', r.via, 'key-route')
      check('key over HTTP', 'no claim', r.claimId, null)
    }
    check('key over HTTP', 'settled once', settled.size, 1)
    s.stop()
  }

  // 2. The key route drops. The buyer claims, the seller's lookout answers on chain, the buyer opens the box.
  {
    const s = await serve(keys.seller, { watch: true, dropKey: true })
    const r = await buyer(s.url)
    check('key on chain', 'status', r.status, 'opened')
    if (r.status !== 'not covered') {
      check('key on chain', 'answer', r.text, ANSWER)
      check('key on chain', 'key came from the chain', r.via, 'chain')
    }
    const refund = r.status !== 'not covered' && r.claimId ? await sealedChain.gasRefundOf(r.claimId) : -1n
    check('key on chain', 'the answer repaid the claim gas', refund > 0n, true)
    check('key on chain', 'the deposit paid only that', await sealedChain.deposits(addressOf(keys.seller)), DEPOSIT - refund)
    s.stop()
  }

  // 3. The key route drops and nobody answers. The deadline passes and the deposit pays the buyer.
  {
    const s = await serve(keys.seller, { watch: false, dropKey: true })
    const depositBefore = await sealedChain.deposits(addressOf(keys.seller))
    const r = await buyer(s.url)
    const owed = r.status === 'not covered' ? 0n : (r.credited ?? 0n)
    check('silence', 'status', r.status, 'silent')
    if (r.status !== 'not covered') {
      check('silence', 'no answer', r.text, null)
      check('silence', 'buyer credited the price and its gas', owed > PRICE, true)
    }
    check('silence', 'deposit fell by twice that', await sealedChain.deposits(addressOf(keys.seller)), depositBefore - 2n * owed)
    check('silence', 'buyer withdraws the credit', await sealedChain.withdrawClaimable(keys.buyer), owed)
    s.stop()
  }

  // 4. A seller with no deposit: the buyer reads the cover and does not pay.
  {
    const before = settled.size
    const s = await serve(keys.bare, { watch: false, dropKey: false })
    const r = await buyer(s.url)
    check('no cover', 'buyer refuses before paying', r.status, 'not covered')
    check('no cover', 'nothing settled', settled.size, before)
    s.stop()
  }

  // 5. A payment for the wrong amount is refused before the route runs.
  {
    const s = await serve(keys.seller, { watch: false, dropKey: false })
    const header = await pay({ ...accepts(addressOf(keys.seller)), amount: '1' })
    const res = await fetch(s.url, { headers: { 'PAYMENT-SIGNATURE': header } })
    check('wrong amount', 'HTTP status', res.status, 402)
    s.stop()
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'sdk-example-'))
const anvil: { child: ChildProcess | null } = { child: null }
const cleanups: (() => void)[] = []
try {
  await main(tmp, anvil, cleanups)
} catch (error) {
  failures++
  console.error(error)
} finally {
  for (const stop of cleanups) {
    try {
      stop()
    } catch {
      // Already stopped.
    }
  }
  if (anvil.child && anvil.child.exitCode === null) {
    const pid = anvil.child.pid
    anvil.child.kill('SIGTERM')
    console.log(`anvil ${pid} stopped: ${anvil.child.killed}`)
  }
  rmSync(tmp, { recursive: true, force: true })
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
