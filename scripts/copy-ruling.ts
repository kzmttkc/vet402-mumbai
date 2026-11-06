// Writes to the real Rabdi testnet, so only run it on purpose:
//   npx bun run scripts/copy-ruling.ts <payTo> [claimId]
//
// A second writer copies one of Arc's rulings to Arkiv. It reads vet402's `vet402_verdict` entity for
// that payTo (the newest one, or the one for claimId), confirms on Arc that the contract emitted the
// Silent or Fraud event for it, and writes the same columns with ARKIV_OTHER_KEY as a writer of its own.
// The entity is readonly with permissionlessExtension, as vet402's own rulings are. Reads ARKIV_OTHER_KEY
// and ARKIV_ACCESS_KEY from the environment. Keys are never printed, and the production writer's key is
// never read, so vet402's own rulings stay only Arc's. A claim this writer already copied is not written again.
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { asc, eq, or } from '@arkiv-network/sdk/query'
import { u64 } from '@arkiv-network/sdk/schema'
import { http } from 'viem'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rulingOnArc } from '../packages/sealed-delivery/src/rulings'
import { RECEIPT_DAYS } from '../server/arkiv'
import { addressColumn, VerdictSchema } from '../src/arkiv/schema'
import { PAGE_SIZE, readAllPages } from '../src/arkiv/pages'

/** vet402's production writer, the one whose ruling is copied. */
const VET402_WRITER: Hex = '0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5'

const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '')

const otherKey = process.env.ARKIV_OTHER_KEY
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ''
const [payTo, claimId] = process.argv.slice(2)
if (!isKey(otherKey)) {
  console.error('ARKIV_OTHER_KEY is not set.')
  process.exit(1)
}
if (!/^0x[0-9a-fA-F]{40}$/.test(payTo ?? '')) {
  console.error('Usage: npx bun run scripts/copy-ruling.ts <payTo> [claimId]')
  process.exit(1)
}

const scrub = (error: unknown) => {
  const raw = error as { shortMessage?: unknown; message?: unknown } | null
  const text = String(raw?.shortMessage ?? raw?.message ?? error)
  return [otherKey, accessKey].filter(Boolean).reduce((out, word) => out.split(word).join('***'), text)
}

const columns = { $key: true, $createdAt: true, claim_id: true, claim_tx: true, seller: true, pay_to: true, verdict: true, contract: true, chain_id: true } as const

async function main(): Promise<void> {
  const account = privateKeyToAccount(otherKey as Hex)
  if (account.address.toLowerCase() === VET402_WRITER.toLowerCase()) throw new Error('ARKIV_OTHER_KEY is the production writer. Use a second key.')
  const chain = rabdi({ accessKey })
  const reads = createPublicClient({ chain, transport: http(undefined, { retryCount: 0 }) })
  const address = addressColumn(payTo!)

  const rulingsBy = (writer: Hex) =>
    readAllPages((offset) =>
      reads
        .select(columns)
        .from(VerdictSchema)
        .where(eq('kind', 'verdict'))
        .where(or(eq('pay_to', address), eq('seller', address)))
        .createdBy(writer)
        .orderBy(asc('$key'))
        .limit(PAGE_SIZE)
        .offset(offset)
        .fetch(),
    )

  const sources = (await rulingsBy(VET402_WRITER))
    .filter((row) => (row.pay_to?.value ?? row.seller.value) === address)
    .filter((row) => !claimId || row.claim_id.value.toLowerCase() === claimId.toLowerCase())
    .sort((a, b) => ((b.$createdAt ?? 0n) > (a.$createdAt ?? 0n) ? 1 : -1))
  const source = sources[0]
  if (!source) throw new Error(`vet402 has no ruling against ${address}${claimId ? ` for claim ${claimId}` : ''}.`)

  const done = (await rulingsBy(account.address)).find((row) => row.claim_id.value === source.claim_id.value)
  if (done) {
    console.log(`already copied: entity ${done.$key} by ${account.address} for claim ${source.claim_id.value}`)
    return
  }

  const ruling = {
    claimId: source.claim_id.value,
    claimTx: source.claim_tx?.value ?? null,
    contract: source.contract.value,
    chainId: source.chain_id.value,
    verdict: source.verdict.value,
    writtenAt: Math.floor(Date.now() / 1000),
  }
  if (!(await rulingOnArc(address, ruling))) throw new Error(`Arc does not hold the ${ruling.verdict} event for claim ${ruling.claimId}. Nothing written.`)

  if ((await reads.getBalance({ address: account.address })) === 0n) throw new Error('ARKIV_OTHER_KEY has no balance on Rabdi, so it cannot write.')
  const writes = createWalletClient({ chain, transport: http(), account })
  const written = await writes.createEntity(
    VerdictSchema,
    {
      kind: 'verdict',
      claim_id: source.claim_id.value,
      seller: address,
      pay_to: address,
      verdict: source.verdict.value,
      ...(source.claim_tx?.value ? { claim_tx: source.claim_tx.value } : {}),
      contract: source.contract.value,
      chain_id: u64(source.chain_id.value),
    },
    { expiration: ExpirationTime.fromDays(RECEIPT_DAYS), flags: { readonly: true, permissionlessExtension: true } },
  )
  console.log(`copied ${ruling.verdict} for claim ${ruling.claimId} against ${address}`)
  console.log(`source entity ${source.$key} by ${VET402_WRITER}`)
  console.log(`entity ${written.entityKey} by ${account.address}`)
  console.log(`tx ${written.txHash}`)
  console.log(`written at ${new Date().toISOString()}`)
}

main().catch((error: unknown) => {
  console.error(`copy-ruling stopped: ${scrub(error)}`)
  process.exit(1)
})
