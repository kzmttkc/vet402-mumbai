import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type WorldRequestKind = 'budget' | 'hold'
export type WorldRequestState = 'waiting' | 'creating' | 'done' | 'closed'

/** One World ID request. Amounts are raw USDC units as strings. */
export interface WorldRequest {
  id: string
  kind: WorldRequestKind
  amount: string
  nonce: string
  expiresAt: number
  state: WorldRequestState
  /** The sentence the screen reads. */
  message: string
  /** True when this hold also asks for a selfie check. Missing in a request saved before the selfie check. */
  selfie?: boolean
}

/** A budget set with its own World ID proof. Amounts are raw USDC units as strings. */
export interface WorldBudget {
  /** The budget request's id. It is part of the signal the budget proof carries. */
  id: string
  amount: string
  sessionId: string
  /** Every hold approved under this budget, plus the gas sent for it. It only goes down when a hold fails before money moved. */
  used: string
  /** The session nullifier of the proof that set this budget, as lowercase hex. */
  nullifier: string
}

export interface WorldRecord {
  /** A file written before budgets had their own proof holds only amount and sessionId. Such a budget counts as unset. */
  budget: WorldBudget | null
  request: WorldRequest | null
  /**
   * Every accepted session nullifier, budget proofs and hold proofs alike, as lowercase hex of the 256-bit integer.
   * A hold with a selfie check adds two: Proof of Human's, then the selfie check's.
   */
  nullifiers: string[]
  /** The last accepted hold proof. Only "Use the last approval" reads it. */
  lastApproval: unknown
}

export interface WorldStore {
  read(): WorldRecord
  /** Replaces the whole record in one rename, so its fields change together or not at all. */
  write(record: WorldRecord): void
}

// A budget's session is made in one environment and can only be proven there, so each environment keeps its own file.
// Staging keeps the name it always had.
const FILE_NAMES = { staging: 'world.json', production: 'world-production.json' } as const

function empty(): WorldRecord {
  return { budget: null, request: null, nullifiers: [], lastApproval: null }
}

// The folder is always passed in, so tests can point it at a temporary directory.
export function createWorldStore(dir: string, environment: keyof typeof FILE_NAMES = 'staging'): WorldStore {
  const file = path.join(dir, FILE_NAMES[environment])

  return {
    read() {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
        throw error
      }
      // A damaged file throws. Starting empty would forget which nullifiers were already accepted.
      return { ...empty(), ...(JSON.parse(text) as Partial<WorldRecord>) }
    },
    write(record) {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
      renameSync(tmp, file)
    },
  }
}
