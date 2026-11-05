// One upload and one read on the real Swarm network, through the public gateway.
// It uses no key and buys nothing: the gateway stamps the upload with its own batch.
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

const swarm = createSwarmWire()
const sent = encodeBox(box)
const reference = await swarm.upload(sent)
console.log(`gateway:   ${SWARM_GATEWAY}`)
console.log(`reference: ${reference}`)
console.log(`open:      ${SWARM_GATEWAY}/bytes/${reference}`)

const back = await swarm.download(reference)
const same = back.length === sent.length && back.every((byte, i) => byte === sent[i])
const parsed = readBox(back, { claimId: box.claimId, contract: box.contract, chainId: box.chainId })
console.log(`bytes:     ${sent.length} sent, ${back.length} read`)
console.log(same && parsed ? 'RESULT: read back the same box' : 'RESULT: the read did not match')
process.exit(same && parsed ? 0 : 1)
