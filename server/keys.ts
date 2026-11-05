import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const ENV_PATH = path.resolve(import.meta.dirname, '../.env')

type KeyName = 'BUYER_PRIVATE_KEY' | 'HOLD_PRIVATE_KEY'

const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '')

// Reads the key from the environment, or creates one and stores it in .env so
// it survives restarts. The key value is never logged.
function loadOrCreate(name: KeyName): Hex {
  const existing = process.env[name]
  if (isKey(existing)) return existing

  const onDisk = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(onDisk)
  const stored = match?.[1]?.trim()
  if (isKey(stored)) {
    process.env[name] = stored
    return stored
  }

  const created = generatePrivateKey()
  const prefix = onDisk.length > 0 && !onDisk.endsWith('\n') ? '\n' : ''
  appendFileSync(ENV_PATH, `${prefix}${name}=${created}\n`, { mode: 0o600 })
  process.env[name] = created
  return created
}

export interface Keys {
  /** The user's funded wallet. It funds the agent and never pays sellers. */
  buyer: Hex
  /** The agent's only spending wallet. It is never a seller. */
  hold: Hex
}

export function loadKeys(): Keys {
  const buyer = loadOrCreate('BUYER_PRIVATE_KEY')
  const hold = loadOrCreate('HOLD_PRIVATE_KEY')
  if (privateKeyToAccount(buyer).address === privateKeyToAccount(hold).address) {
    throw new Error('Buyer and hold keys must be different.')
  }
  return { buyer, hold }
}
