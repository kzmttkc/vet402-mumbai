import { ARC_GATEWAY_API } from '../src/existing/arc-gateway'

/** Circle's record of a payment. Only the fields we check are read. */
export interface Transfer {
  id?: unknown
  status?: unknown
  toAddress?: unknown
  fromAddress?: unknown
  amount?: unknown
  nonce?: unknown
}

/** The record may appear late, so a read is tried up to this many times, this far apart. */
export const RECORD_ATTEMPTS = 5
export const RECORD_DELAY_MS = 2000

const READ_TIMEOUT_MS = 10_000

export interface RecordDeps {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** GET {Gateway API}/x402/transfers?{query}. */
export async function fetchTransfers(query: string, fetchImpl: typeof fetch = fetch): Promise<Transfer[]> {
  const res = await fetchImpl(`${ARC_GATEWAY_API}/x402/transfers?${query}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Circle record read failed with status ${res.status}`)
  const body = (await res.json()) as unknown
  const list = Array.isArray(body) ? body : (body as { transfers?: unknown } | null)?.transfers
  return Array.isArray(list) ? (list as Transfer[]) : []
}

const lower = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '')

export interface ExpectedPayment {
  seller: string
  payer: string
  /** Atomic USDC units as an integer string, e.g. "1000". */
  amount: string
}

/**
 * True only when the record holds exactly one transfer for this payment, it has not failed,
 * it went to the seller from the payer (compared in lowercase), and its amount is the integer string.
 */
export function isOnePayment(transfers: Transfer[], expected: ExpectedPayment): boolean {
  if (transfers.length !== 1) return false
  const [transfer] = transfers
  return (
    typeof transfer?.status === 'string' &&
    transfer.status !== 'failed' &&
    lower(transfer.toAddress) === expected.seller.toLowerCase() &&
    lower(transfer.fromAddress) === expected.payer.toLowerCase() &&
    transfer.amount === expected.amount
  )
}

/** Reads again, a few seconds apart, until `accept` is happy or the attempts run out. */
export async function readWithRetries<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  { sleep = defaultSleep }: Pick<RecordDeps, 'sleep'> = {},
): Promise<{ ok: boolean; value: T | null }> {
  let value: T | null = null
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt++) {
    try {
      value = await read()
      if (accept(value)) return { ok: true, value }
    } catch {
      // The record may not be reachable yet. Try again.
    }
    if (attempt < RECORD_ATTEMPTS) await sleep(RECORD_DELAY_MS)
  }
  return { ok: false, value }
}

/** Is there exactly one good transfer for this payment's nonce? */
export async function readOnePayment(
  nonce: string,
  expected: ExpectedPayment,
  deps: RecordDeps = {},
): Promise<{ ok: boolean; transfer: Transfer | null }> {
  const { ok, value } = await readWithRetries(
    () => fetchTransfers(`nonce=${encodeURIComponent(nonce)}`, deps.fetchImpl),
    (transfers) => isOnePayment(transfers, expected),
    deps,
  )
  return { ok, transfer: ok ? (value?.[0] ?? null) : null }
}

/** How many of these nonces appear in the record of everything this payer sent to this seller. */
export const countNonces = (transfers: Transfer[], nonces: string[]): number => {
  const wanted = new Set(nonces.map((n) => n.toLowerCase()))
  return transfers.filter((t) => wanted.has(lower(t.nonce))).length
}

/** Reads by payer and seller, and waits until both of the two nonces are there. */
export async function readComparison(
  payer: string,
  seller: string,
  nonces: string[],
  deps: RecordDeps = {},
): Promise<number> {
  const query = `from=${encodeURIComponent(payer)}&to=${encodeURIComponent(seller)}`
  const { value } = await readWithRetries(
    () => fetchTransfers(query, deps.fetchImpl),
    (transfers) => countNonces(transfers, nonces) === nonces.length,
    deps,
  )
  return countNonces(value ?? [], nonces)
}
