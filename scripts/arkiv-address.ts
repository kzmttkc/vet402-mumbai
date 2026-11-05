// Prints the address receipts are written from. It derives it from the key and never prints the key.
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const key = process.env.ARKIV_WRITER_KEY ?? ''
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('ARKIV_WRITER_KEY is not set.')
  process.exit(1)
}
console.log(privateKeyToAccount(key as Hex).address)
