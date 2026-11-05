import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** What the app remembers about the current hold. Amounts are raw USDC units as strings. */
export interface HoldRecord {
  /** The amount the user chose to hold. */
  amount: string
  /** True once the hold has been seen as spendable, so "used up" is never shown too early. */
  seenFunded: boolean
}

export interface HoldStore {
  read(): HoldRecord | null
  write(record: HoldRecord): void
  clear(): void
}

const FILE_NAME = 'hold.json'

// The folder is always passed in, so tests can point it at a temporary directory.
export function createHoldStore(dir: string): HoldStore {
  const file = path.join(dir, FILE_NAME)

  return {
    read() {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<HoldRecord>
        if (typeof parsed.amount !== 'string' || typeof parsed.seenFunded !== 'boolean') return null
        return { amount: parsed.amount, seenFunded: parsed.seenFunded }
      } catch {
        return null
      }
    },
    write(record) {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
      renameSync(tmp, file)
    },
    clear() {
      rmSync(file, { force: true })
    },
  }
}
