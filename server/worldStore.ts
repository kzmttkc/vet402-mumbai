import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type WorldRequestKind = 'budget' | 'hold'
export type WorldRequestState = 'waiting' | 'creating' | 'done' | 'closed'

/** One World ID request. Amounts are raw USDC units as strings. */
export interface WorldRequest {
  id: string
  kind: WorldRequestKind
  amount: string
  /** Only a pending hold has a job id. */
  jobId: string | null
  nonce: string
  expiresAt: number
  state: WorldRequestState
  /** The sentence the screen reads. */
  message: string
}

export interface WorldRecord {
  budget: { amount: string; sessionId: string } | null
  request: WorldRequest | null
  /** Every accepted session nullifier, as lowercase hex of the 256-bit integer. */
  nullifiers: string[]
  /** The last accepted hold proof. Only "Use the last approval" reads it. */
  lastApproval: unknown
}

export interface WorldStore {
  read(): WorldRecord
  /** Replaces the whole record in one rename, so its fields change together or not at all. */
  write(record: WorldRecord): void
}

const FILE_NAME = 'world.json'

function empty(): WorldRecord {
  return { budget: null, request: null, nullifiers: [], lastApproval: null }
}

// The folder is always passed in, so tests can point it at a temporary directory.
export function createWorldStore(dir: string): WorldStore {
  const file = path.join(dir, FILE_NAME)

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
