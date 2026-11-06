// Runs against the real Rabdi testnet, so only run it on purpose: npx bun run scripts/arkiv-live.ts
//
// Reads ARKIV_WRITER_KEY and ARKIV_ACCESS_KEY from the environment, and ARKIV_OTHER_KEY when there is
// a second funded key to try. Keys are never printed. It writes one payment, one settlement and one
// seller under a "live-check-" name, tries to change the payment with the writer's own key, and
// writes one ruling against a fresh address that no seller uses. The receipts screen leaves those
// rows out, and they expire on their own within minutes, so nothing is left behind on screen.
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { eq } from '@arkiv-network/sdk/query'
import { http } from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createArkivReader } from '../src/arkiv/readArkiv'
import { buildRows } from '../src/arkiv/receiptsFeed'
import { LIVE_CHECK_PREFIX, ReceiptSchema, SellerSchema } from '../src/arkiv/schema'
import { receiptStatusLine } from '../src/lib/receiptStatus'
import { createArkivWire, createScrubber, createSellerCheck, RULED_AGAINST } from '../server/arkiv'

const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '')

const writerKey = process.env.ARKIV_WRITER_KEY
const otherKey = process.env.ARKIV_OTHER_KEY
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ''
if (!isKey(writerKey)) {
  console.error('ARKIV_WRITER_KEY is not set.')
  process.exit(1)
}

const scrub = createScrubber([writerKey, accessKey, otherKey ?? ''])
let failed = 0

function report(id: string, ok: boolean, detail: string): void {
  if (!ok) failed++
  console.log(`${id} ${ok ? 'OK' : 'NG'} ${detail}`)
}

const chain = rabdi({ accessKey })
const { wire, writer } = createArkivWire({ writerKey, accessKey })
const writerAccount = privateKeyToAccount(writerKey)
const reads = createPublicClient({ chain, transport: http() })
const run = `${LIVE_CHECK_PREFIX}${Date.now()}`
const transferId = `${run}-transfer`
const SELLER_TTL_SECONDS = 60

console.log(`writer ${writer}`)
console.log(`chain ${chain.id}, seller name ${run}`)

const readReceipts = async () =>
  (
    await reads
      .select({ $key: true, $expiresAt: true, $creationFlags: true, kind: true, payment_key: true })
      .from(ReceiptSchema)
      .where(eq('gateway_transfer_id', transferId))
      .ownedBy(writer)
      .fetch()
  ).entities

const readSeller = async () =>
  (
    await reads
      .select({ $key: true, $expiresAt: true, $creationFlags: true })
      .from(SellerSchema)
      .where(eq('seller', run))
      .ownedBy(writer)
      .fetch()
  ).entities

/** Asks until the node shows the writes, because a read can land just behind a write. */
async function untilSeen<T>(read: () => Promise<readonly T[]>, want: number): Promise<readonly T[]> {
  let rows = await read()
  for (let i = 0; i < 10 && rows.length < want; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    rows = await read()
  }
  return rows
}

const common = {
  job_id: `${run}-job`,
  seller: run,
  amount_micro: 1000n,
  gateway_transfer_id: transferId,
  response_hash: 'f'.repeat(64),
  response_bytes: 42n,
  times_received: 1n,
}
// Minutes, not the app's 30 days, so these rows do not stay around for the demo.
const receiptOptions = {
  expiration: ExpirationTime.fromMinutes(10),
  flags: { readonly: true, permissionlessExtension: true },
} as const

async function main(): Promise<void> {
  const t0 = Date.now()
  const payment = await wire.createReceipt({ kind: 'payment', ...common, status: 'accepted' }, receiptOptions)
  console.log(`payment written in ${Date.now() - t0} ms, key ${payment.entityKey}`)

  const t1 = Date.now()
  const settlement = await wire.createReceipt(
    {
      kind: 'settlement',
      ...common,
      status: 'settled',
      batch_tx: `0x${'c'.repeat(64)}`,
      payment_key: payment.entityKey,
    },
    receiptOptions,
  )
  console.log(`settlement written in ${Date.now() - t1} ms, key ${settlement.entityKey}`)

  const t2 = Date.now()
  const seller = await wire.createSeller(
    { kind: 'seller', seller: run },
    { expiration: ExpirationTime.fromSeconds(SELLER_TTL_SECONDS), flags: { readonly: true } },
  )
  console.log(`seller written in ${Date.now() - t2} ms, key ${seller.entityKey}`)

  const rows = await untilSeen(readReceipts, 2)
  const sellerRows = await untilSeen(readSeller, 1)
  const paymentRow = rows.find((r) => r.kind.value === 'payment')
  const settlementRow = rows.find((r) => r.kind.value === 'settlement')

  // (1) What the browser does: the public endpoint, no key, no backend.
  const browser = await createArkivReader(writer)()
  const browserRows = browser.receipts.filter((r) => r.seller === run)
  report('(1)', browserRows.length === 2, `no-key read returned ${browserRows.length} of 2 rows without the backend`)

  // (2) One payment, one settlement, and the row moves from Accepted to Settled.
  const onScreen = buildRows({
    receipts: browserRows.map((r) => ({ ...r, seller: 'shown' })),
    sellers: [],
    timing: browser.timing,
  })[0]
  report(
    '(2)',
    !!paymentRow && !!settlementRow && settlementRow.payment_key?.value === payment.entityKey,
    `payment ${paymentRow ? 1 : 0}, settlement ${settlementRow ? 1 : 0}, line "${
      onScreen ? receiptStatusLine(onScreen.settled ? 'completed' : 'received', onScreen.batchTx) : 'none'
    }"`,
  )
  report(
    '(flags)',
    paymentRow?.$creationFlags?.readonly === true &&
      paymentRow.$creationFlags.permissionlessExtension === true &&
      sellerRows[0]?.$creationFlags?.readonly === true &&
      sellerRows[0].$creationFlags.permissionlessExtension === false,
    'payment readonly and open to extension, seller readonly and owner only',
  )

  // (3) The seller entity's expiry moves out on delivery. An extension sets the expiry to the block it
  // lands in plus the lifetime. It does not add the lifetime to what was left.
  const before = sellerRows[0]?.$expiresAt ?? 0n
  const lifetimeBlocks = BigInt((SELLER_TTL_SECONDS + 4) / 2)
  const sentAt = await reads.getBlockNumber()
  const { expiresAt: after } = await wire.extendEntity({
    entityKey: seller.entityKey,
    expiration: ExpirationTime.fromSeconds(SELLER_TTL_SECONDS + 4),
  })
  const landedBy = await reads.getBlockNumber()
  const isSet = after > sentAt + lifetimeBlocks - 1n && after <= landedBy + lifetimeBlocks
  report(
    '(3)',
    after > before && isSet && after !== before + lifetimeBlocks,
    `seller expiry block ${before} to ${after}. Sent at block ${sentAt}, landed by ${landedBy}, lifetime ${lifetimeBlocks} blocks, so the expiry was ${isSet ? 'set from the landing block' : 'not set from the landing block'}, not ${before + lifetimeBlocks}`,
  )

  // (11) readonly holds against the writer too: vet402's own key tries to change the receipt and is refused.
  const ownerClient = createWalletClient({ chain, transport: http(), account: writerAccount })
  try {
    await ownerClient.patchEntity(ReceiptSchema, payment.entityKey, { set: { response_hash: '0'.repeat(64) } })
    report('(11)', false, 'the writer changed a readonly receipt, which must be refused')
  } catch (error) {
    report('(11)', true, `the writer was refused a change to its own receipt: ${scrub(error).slice(0, 120)}`)
  }

  // (4) The README's query, sent by hand.
  const res = await fetch(chain.rpcUrls.default.http[0], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'arkiv_query',
      params: [
        `arkiv.schema = str('vet402_receipt') AND gateway_transfer_id = str('${transferId}') AND $owner = addr(${writer})`,
        { select: { key: true, expiresAt: true, attributes: true } },
      ],
    }),
  })
  const body = (await res.json()) as { result?: { data?: { key?: string }[] } }
  const readmeKeys = (body.result?.data ?? []).map((row) => row.key?.toLowerCase()).sort()
  const expectedKeys = [payment.entityKey.toLowerCase(), settlement.entityKey.toLowerCase()].sort()
  report('(4)', JSON.stringify(readmeKeys) === JSON.stringify(expectedKeys), `README query returned ${readmeKeys.length} rows`)

  console.log('(5) by hand: run the grep in arkiv/how-you-use-arkiv.md')
  console.log('(6) by hand: the 429 path is covered by server/__tests__/receiptsFeed.test.ts')

  // (8) and (9) need a second funded key. This script never sends it funds.
  if (isKey(otherKey)) {
    const other = privateKeyToAccount(otherKey)
    const balance = await reads.getBalance({ address: other.address })
    if (balance === 0n) {
      report('(8)(9)', false, 'ARKIV_OTHER_KEY has no balance, so it cannot send anything')
    } else {
      const otherClient = createWalletClient({ chain, transport: http(), account: other })
      try {
        const extended = await otherClient.extendEntity({
          entityKey: payment.entityKey,
          expiration: ExpirationTime.fromMinutes(12),
        })
        report('(8)', true, `another key kept the receipt alive until block ${extended.expiresAt}`)
      } catch (error) {
        report('(8)', false, `another key could not extend the receipt: ${scrub(error)}`)
      }
      try {
        await otherClient.extendEntity({ entityKey: seller.entityKey, expiration: ExpirationTime.fromMinutes(12) })
        report('(9)', false, 'another key extended the seller entity, which must be refused')
      } catch (error) {
        report('(9)', true, `another key was refused on the seller entity: ${scrub(error).slice(0, 120)}`)
      }
    }
  } else {
    console.log('(8)(9) skipped: ARKIV_OTHER_KEY is not set')
  }

  // (7) The expiry scene: while the seller is alive it goes on, once it is gone the purchase stops.
  const check = createSellerCheck(wire, (message) => console.error(message), scrub)
  const whileAlive = await check(run)
  report('(7a)', whileAlive.kind === 'live', `while alive: "${whileAlive.line}"`)

  const started = Date.now()
  let gone = false
  while (Date.now() - started < 150_000) {
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    if ((await readSeller()).length === 0) {
      gone = true
      break
    }
  }
  report('(7b)', gone, `seller entity left the query after about ${Math.round((Date.now() - started) / 1000)} s`)
  const afterExpiry = await check(run)
  report('(7c)', afterExpiry.kind === 'expired', `after expiry: "${afterExpiry.line}"`)

  // (10) A ruling from Arc stops the purchase. The address is fresh, so no real seller is marked.
  const ruledPayTo = privateKeyToAccount(generatePrivateKey()).address
  await wire.createVerdict(
    {
      kind: 'verdict',
      claim_id: `${run}-claim`,
      seller: ruledPayTo.toLowerCase(),
      verdict: 'silent',
      contract: `0x${'0'.repeat(40)}`,
      chain_id: 0n,
    },
    receiptOptions,
  )
  const ruledCheck = createSellerCheck(wire, (message) => console.error(message), scrub, () => ruledPayTo)
  let ruled = await ruledCheck(run)
  for (let i = 0; i < 10 && ruled.line !== RULED_AGAINST; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    ruled = await ruledCheck(run)
  }
  report('(10)', ruled.kind === 'expired' && ruled.line === RULED_AGAINST, `with a ruling on Arkiv: "${ruled.line}"`)
}

main()
  .catch((error: unknown) => {
    failed++
    console.error(`live check stopped: ${scrub(error)}`)
  })
  .finally(() => {
    console.log(failed === 0 ? 'live check: all OK' : `live check: ${failed} NG`)
    process.exit(failed === 0 ? 0 : 1)
  })
