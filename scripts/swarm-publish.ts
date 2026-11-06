// Puts the receipts page on Swarm under one address that never changes.
//
// 1. Builds receipts.html and the files it loads, with relative paths, so the page opens from any bzz URL.
// 2. Uploads that folder to your own Bee node as one collection, with receipts.html as its index, and pins it.
// 3. Points a feed at the new collection. The feed manifest is the fixed bzz URL: each run moves the
//    feed to the newest page, and the URL stays the same.
//
// Your own Bee node only: SWARM_API_URL is its API, SWARM_POSTAGE_BATCH_ID the batch it stamps with,
// SWARM_FEED_KEY the key that signs the feed (any 32 byte key kept for this feed alone). The page reads
// Arkiv by the writer's address, from ARKIV_WRITER_ADDRESS, the same variable the public deploy uses.
//
// Run:      npx bun run scripts/swarm-publish.ts
// Look:     npx bun run scripts/swarm-publish.ts --dry-run   (builds and lists the files, uploads nothing)
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bee, PrivateKey, SWARM_GATEWAY_URL, Topic } from '@ethersphere/bee-js'

/** The feed's topic. The manifest's address follows from it and the feed key alone. */
export const RECEIPTS_TOPIC = 'vet402-receipts-page'
export const INDEX_DOCUMENT = 'receipts.html'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every file under a folder, as paths relative to it. */
export function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? listFiles(full, base) : [path.relative(base, full)]
  })
}

/** Builds the receipts page alone, with relative asset paths, into `outDir`. */
export async function buildReceiptsPage(outDir: string): Promise<string[]> {
  const { build } = await import('vite')
  const configFor = (await import('../vite.config')).default as unknown as (env: { mode: string; command: 'build' }) => Record<string, unknown>
  const config = configFor({ mode: 'production', command: 'build' })
  await build({
    ...config,
    configFile: false,
    root: ROOT,
    base: './',
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, rollupOptions: { input: { receipts: path.join(ROOT, INDEX_DOCUMENT) } } },
  })
  return listFiles(outDir)
}

/** The fixed URLs of a feed manifest: the bzz address, and the same page through the public gateway. */
export const pageUrls = (manifest: string) => ({ bzz: `bzz://${manifest}`, gateway: `${SWARM_GATEWAY_URL}/bzz/${manifest}/` })

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const apiUrl = process.env.SWARM_API_URL ?? ''
  const batchId = process.env.SWARM_POSTAGE_BATCH_ID ?? ''
  const feedKey = process.env.SWARM_FEED_KEY ?? ''
  if (!process.env.ARKIV_WRITER_ADDRESS) console.error('ARKIV_WRITER_ADDRESS is empty, so the page will list no receipts.')

  const outDir = mkdtempSync(path.join(os.tmpdir(), 'vet402-receipts-'))
  try {
    const files = await buildReceiptsPage(outDir)
    console.log(`built:     ${files.length} files, index ${INDEX_DOCUMENT}`)
    for (const file of files) console.log(`           ${file}`)
    if (dryRun) return

    if (!apiUrl || !/^(0x)?[0-9a-fA-F]{64}$/.test(batchId) || !/^(0x)?[0-9a-fA-F]{64}$/.test(feedKey)) {
      throw new Error('Set SWARM_API_URL, SWARM_POSTAGE_BATCH_ID and SWARM_FEED_KEY to your own Bee node, its batch and the feed key.')
    }
    const bee = new Bee(apiUrl)
    const signer = new PrivateKey(feedKey)
    const owner = signer.publicKey().address()
    const topic = Topic.fromString(RECEIPTS_TOPIC)

    // One collection: the page and everything it loads, opened at receipts.html.
    const { reference } = await bee.collection.uploadFromDirectory(batchId, outDir, {
      indexDocument: INDEX_DOCUMENT,
      errorDocument: INDEX_DOCUMENT,
    })
    await bee.pin.add(reference)
    console.log(`page:      ${reference.toHex()} (pinned on ${apiUrl})`)

    // The feed now names this collection. The manifest resolves the feed's newest update on every read.
    await bee.feed.makeWriter(topic, signer).uploadReference(batchId, reference)
    const manifest = (await bee.feed.createManifest(batchId, topic, owner)).toHex()
    await bee.pin.add(manifest)
    const urls = pageUrls(manifest)
    const batch = await bee.stamp.get(batchId)
    console.log(`feed:      topic "${RECEIPTS_TOPIC}", owner ${owner.toHex()}`)
    console.log(`fixed URL: ${urls.bzz}`)
    console.log(`open:      ${urls.gateway}`)
    console.log(`kept:      until ${batch.duration.toEndDate().toISOString().slice(0, 10)} by batch ${batchId.slice(0, 8)}…`)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
