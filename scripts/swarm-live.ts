// One upload and one read on the real Swarm network. By default through the public gateway, which
// stamps the upload with its own batch, so it uses no key and buys nothing. SWARM_API_URL points it at
// another Bee API, such as your own node, and SWARM_POSTAGE_BATCH_ID is the batch that node stamps with,
// the same two variables the server reads. The read always goes through the public gateway, so a box
// your node uploaded is shown to be readable by anyone.
// Run: npx bun run scripts/swarm-live.ts
import { keccak256, toHex } from 'viem'
import { createSwarmWire, encodeBox, readBox, SWARM_GATEWAY } from '../src/lib/swarmBox'
import type { EvidenceBox } from '../src/lib/swarmBox'

const ciphertext = toHex(new TextEncoder().encode(`vet402 swarm-live ${new Date().toISOString()}`))
const box: EvidenceBox = {
  ciphertext,
  claimId: `0x${'00'.repeat(31)}01`,
  plaintextHash: `0x${'00'.repeat(32)}`,
  ciphertextHash: keccak256(ciphertext),
  contract: `0x${'00'.repeat(20)}`,
  chainId: 5042002,
}

const uploadUrl = process.env.SWARM_API_URL || SWARM_GATEWAY
const batch = process.env.SWARM_POSTAGE_BATCH_ID || undefined
const uploader = createSwarmWire(uploadUrl, undefined, batch)
const reader = createSwarmWire(SWARM_GATEWAY)
const sent = encodeBox(box)
const reference = await uploader.upload(sent)
console.log(`upload:    ${uploadUrl} with ${batch ? `batch ${batch.slice(0, 8)}…` : "the gateway's own batch (null stamp)"}`)
console.log(`reference: ${reference}`)
console.log(`open:      ${SWARM_GATEWAY}/bytes/${reference}`)

// A box from your own node can take a moment to reach the gateway, so the read is tried a few times.
let back: Uint8Array = new Uint8Array()
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    back = await reader.download(reference)
    break
  } catch (error) {
    if (attempt === 4) throw error
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}
const same = back.length === sent.length && back.every((byte, i) => byte === sent[i])
const parsed = readBox(back, { claimId: box.claimId, contract: box.contract, chainId: box.chainId })
console.log(`bytes:     ${sent.length} sent, ${back.length} read`)
console.log(same && parsed ? 'RESULT: read back the same box' : 'RESULT: the read did not match')
process.exit(same && parsed ? 0 : 1)
