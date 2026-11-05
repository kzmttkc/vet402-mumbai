// Writes the receipt list and statuses to public/static/ for the published screen.
// Run before a build: npx bun run scripts/export-public.ts [--data <folder>] [--out <folder>]
// Every field is named here. A new field on the receipt row stays out until someone adds it on purpose.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createReceiptStore } from '../server/receiptStore'
import type { ReceiptRow } from '../server/receiptStore'
import { COMPARISON_LINE } from '../src/lib/receiptStatus'
import type { CheckFile, PublicReceiptsFile, PublicStatusesFile } from '../src/lib/publicData'
import { formatUsdc } from '../src/onchain-money'

/** The nonce and the batch tx are 32 bytes on purpose. An address has no business anywhere in the output. */
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/
/** Free text must hold no address and no key, with or without the 0x. */
const LONG_HEX = /[0-9a-fA-F]{40,}/

function assertPlain(ref: string, field: string, value: string | null) {
  if (value !== null && LONG_HEX.test(value)) throw new Error(`${ref}: ${field} holds a long hex value. Nothing was written.`)
}

function readRows(dataDir: string): ReceiptRow[] {
  const file = path.join(dataDir, 'receipts.json')
  if (!existsSync(file)) throw new Error(`${file} does not exist. Nothing was written.`)
  // The store reads an unreadable file as empty. An export must say so instead.
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(raw)) throw new Error(`${file} is not a list. Nothing was written.`)
  const rows = createReceiptStore(dataDir).list()
  if (rows.length !== raw.length) {
    throw new Error(`${file}: ${raw.length - rows.length} of ${raw.length} rows are not valid. Nothing was written.`)
  }
  if (rows.length === 0) throw new Error(`${file} has no receipts. Nothing was written.`)
  return rows
}

/** The newest payment that went through, a settled one first. Comparison rows show the thing vet402 prevents. */
export function pickEventPayment(rows: ReceiptRow[]): ReceiptRow | null {
  const usable = rows.filter((r) => r.nonce && r.transferId && r.status !== 'failed' && !r.comparison)
  return usable.find((r) => r.status === 'completed') ?? usable[0] ?? null
}

export interface Exported {
  receipts: PublicReceiptsFile
  statuses: PublicStatusesFile
  check: CheckFile
}

export function toPublic(rows: ReceiptRow[]): Exported {
  const receipts: PublicReceiptsFile = { receipts: [] }
  const statuses: PublicStatusesFile = { statuses: {} }

  rows.forEach((row, index) => {
    const ref = `r${index}`
    const outcome = [...(row.outcome ?? []), ...(row.comparison ? [COMPARISON_LINE] : [])]
    assertPlain(ref, 'sellerName', row.sellerName)
    assertPlain(ref, 'transferId', row.transferId)
    outcome.forEach((line) => assertPlain(ref, 'outcome', line))

    receipts.receipts.push({
      ref,
      amount: formatUsdc(BigInt(row.amount)),
      sellerName: row.sellerName,
      responseHash: row.responseHash,
      responseBytes: row.responseBytes,
      transferId: row.transferId,
      outcome,
    })
    statuses.statuses[ref] = { status: row.status, batchTx: row.batchTx }
  })

  const event = pickEventPayment(rows)
  const check: CheckFile = { eventNonce: event?.nonce ?? null, eventTransferId: event?.transferId ?? null }
  return { receipts, statuses, check }
}

export function exportPublic({ dataDir, outDir }: { dataDir: string; outDir: string }) {
  const rows = readRows(dataDir)
  const exported = toPublic(rows)
  const files = {
    'receipts.json': exported.receipts,
    'statuses.json': exported.statuses,
    'check.json': exported.check,
  }
  // Every file is built and checked before the first one is written.
  const texts = Object.entries(files).map(([name, content]) => [name, JSON.stringify(content)] as const)
  for (const [name, text] of texts) {
    if (ADDRESS.test(text)) throw new Error(`${name} would hold an address. Nothing was written.`)
  }
  mkdirSync(outDir, { recursive: true })
  for (const [name, text] of texts) writeFileSync(path.join(outDir, name), text)
  return { rows: rows.length, event: pickEventPayment(rows) }
}

if (import.meta.main) {
  const option = (name: string) => {
    const at = process.argv.indexOf(name)
    return at === -1 ? undefined : process.argv[at + 1]
  }
  const root = path.resolve(import.meta.dirname, '..')
  const dataDir = option('--data') ?? process.env.DATA_DIR ?? path.join(root, 'data')
  const outDir = option('--out') ?? path.join(root, 'public', 'static')
  const { rows, event } = exportPublic({ dataDir, outDir })
  console.log(`Exported ${rows} receipts to ${outDir}.`)
  console.log(
    event
      ? `Event payment for the Check a receipt panel: ${event.sellerName}, ${formatUsdc(BigInt(event.amount))} USDC, ${event.status}.`
      : 'No payment fits the Check a receipt panel. It offers the pre-event payment only.',
  )
}
