// Reproduces item 1 of arkiv/friction.md: a wrong access key, and where it shows up in the error.
// Run: npx bun run scripts/arkiv-401.ts
// The key here is made up for the test, so printing it is safe. The output masks it anyway, the way vet402's logs do.
import { createPublicClient } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { http } from 'viem'

const WRONG_KEY = 'not-a-real-key-123456'
const mask = (text: string) => text.split(WRONG_KEY).join('<access key>')

const client = createPublicClient({ chain: rabdi({ accessKey: WRONG_KEY }), transport: http(undefined, { retryCount: 0 }) })
try {
  await client.getBlockNumber()
  console.log('The node answered. No 401 to show.')
} catch (error) {
  const e = error as { message?: string; shortMessage?: string }
  console.log('error.message holds the key:', String(e.message ?? '').includes(WRONG_KEY))
  console.log('shortMessage holds the key:', String(e.shortMessage ?? '').includes(WRONG_KEY))
  console.log('error.message, masked:\n' + mask(String(e.message ?? '')).split('\n').slice(0, 6).join('\n'))
  console.log('shortMessage:\n' + mask(String(e.shortMessage ?? '')))
}
