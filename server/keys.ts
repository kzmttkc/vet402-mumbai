import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const DEFAULT_ENV_PATH = path.resolve(import.meta.dirname, '../.env')

type KeyName =
  | 'BUYER_PRIVATE_KEY'
  | 'HOLD_PRIVATE_KEY'
  | 'SELLER_A_PRIVATE_KEY'
  | 'SELLER_B_PRIVATE_KEY'
  | 'SELLER_C_PRIVATE_KEY'

type Env = Record<string, string | undefined>

const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '')

// Reads the key from the environment, or creates one and stores it in the env file so
// it survives restarts. The key value is never logged.
function loadOrCreate(name: KeyName, env: Env, envPath: string): Hex {
  const existing = env[name]
  if (isKey(existing)) return existing

  const onDisk = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(onDisk)
  const stored = match?.[1]?.trim()
  if (isKey(stored)) {
    env[name] = stored
    return stored
  }

  const created = generatePrivateKey()
  const prefix = onDisk.length > 0 && !onDisk.endsWith('\n') ? '\n' : ''
  appendFileSync(envPath, `${prefix}${name}=${created}\n`, { mode: 0o600 })
  env[name] = created
  return created
}

export interface Keys {
  /** The user's funded wallet. It funds the agent and never pays sellers. */
  buyer: Hex
  /** The agent's only spending wallet. It is never a seller. */
  hold: Hex
  /** Each demo seller has its own key, separate from every other wallet here. */
  sellerA: Hex
  sellerB: Hex
  sellerC: Hex
}

// `env` and `envPath` are parameters so tests can use a plain object and a temporary file
// instead of the app's real environment and .env.
export function loadKeys(env: Env = process.env, envPath: string = DEFAULT_ENV_PATH): Keys {
  const keys: Keys = {
    buyer: loadOrCreate('BUYER_PRIVATE_KEY', env, envPath),
    hold: loadOrCreate('HOLD_PRIVATE_KEY', env, envPath),
    sellerA: loadOrCreate('SELLER_A_PRIVATE_KEY', env, envPath),
    sellerB: loadOrCreate('SELLER_B_PRIVATE_KEY', env, envPath),
    sellerC: loadOrCreate('SELLER_C_PRIVATE_KEY', env, envPath),
  }

  const addresses = Object.values(keys).map((key) => privateKeyToAccount(key).address)
  if (new Set(addresses).size !== addresses.length) {
    throw new Error('Buyer, hold and seller keys must all be different. The hold key is never a seller.')
  }
  return keys
}
