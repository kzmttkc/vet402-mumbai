import { formatUsdc } from '@/onchain-money'

/** The pre-event batch payment. It settled on Circle's production Gateway, before Arkiv was in use. */
export const PRE_EVENT_NONCE = '0x85913b5ba5510e03258433ca51c7e9a6e3a4c972766eb9964ba900ceb33aa304'

export const CIRCLE_PRODUCTION = 'https://gateway-api.circle.com'
export const CIRCLE_TESTNET = 'https://gateway-api-testnet.circle.com'

export const COULD_NOT_READ_CIRCLE = 'Could not read Circle.'
export const COULD_NOT_READ_ARKIV = 'Could not read Arkiv.'
const ARKIV_ATTEMPTS = 3
export const ARKIV_NOT_USED = 'Arkiv: not used before the event.'

const READ_TIMEOUT_MS = 10_000

export interface CircleTransfer {
  id: string
  status: string
  /** Atomic USDC units, as an integer string. */
  amount: string
}

export const isPreEvent = (nonce: string) => nonce.toLowerCase() === PRE_EVENT_NONCE

/** Only the pre-event payment went through production. Every payment of the event went through testnet. */
export const circleHostFor = (nonce: string) => (isPreEvent(nonce) ? CIRCLE_PRODUCTION : CIRCLE_TESTNET)

export const circleLine = (n: number) =>
  n === 1 ? 'Circle record: 1 transfer for this payment.' : `Circle record: ${n} transfers for this payment.`

export const arkivLine = (n: number) =>
  n === 1 ? 'Arkiv: 1 entity for this payment.' : `Arkiv: ${n} entities for this payment.`

/** Circle reports atomic units, so 5000 is 0.005 USDC. */
export const amountLine = (atomic: string) => `${formatUsdc(BigInt(atomic))} USDC`

const isTransfer = (value: unknown): value is CircleTransfer => {
  const t = value as Partial<CircleTransfer> | null
  return (
    !!t &&
    typeof t.id === 'string' &&
    typeof t.status === 'string' &&
    typeof t.amount === 'string' &&
    /^\d+$/.test(t.amount)
  )
}

/** Null means the record could not be read. An empty list means Circle answered and has nothing. */
export async function readCircle(nonce: string, fetchImpl: typeof fetch = fetch): Promise<CircleTransfer[] | null> {
  try {
    const res = await fetchImpl(`${circleHostFor(nonce)}/v1/x402/transfers?nonce=${encodeURIComponent(nonce)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    const list = Array.isArray(body) ? body : (body as { transfers?: unknown } | null)?.transfers
    return Array.isArray(list) && list.every(isTransfer) ? list : null
  } catch {
    return null
  }
}

export interface CheckDeps {
  /** Wait between Arkiv reads after a refusal. Tests set it to 0. */
  retryMs?: number
  fetchImpl?: typeof fetch
  /** Counts the Arkiv entities for these transfer ids. Throws when Arkiv cannot be read. Null with no writer in the build. */
  countEntities: ((transferIds: string[]) => Promise<number>) | null
  /** The transfer id the published page already knows for this nonce, so Arkiv can be read while Circle is down. */
  knownTransferId?: string | null
}

export interface CheckResult {
  circle: string[]
  arkiv: string
}

async function arkivResult(transferIds: string[] | null, deps: CheckDeps): Promise<string> {
  // No id to look for, because Circle could not be read. That is not the same as none on Arkiv.
  if (transferIds === null) return COULD_NOT_READ_ARKIV
  if (transferIds.length === 0) return arkivLine(0)
  if (!deps.countEntities) return COULD_NOT_READ_ARKIV
  // The public node turns down bursts, so a refused read is tried again before it shows as a failure.
  for (let attempt = 0; attempt < ARKIV_ATTEMPTS; attempt++) {
    try {
      return arkivLine(await deps.countEntities(transferIds))
    } catch {
      if (attempt + 1 < ARKIV_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, (deps.retryMs ?? 1500) * (attempt + 1)))
    }
  }
  return COULD_NOT_READ_ARKIV
}

/** Reads Circle and Arkiv from the browser. A failed read only ever replaces its own line. */
export async function checkReceipt(input: string, deps: CheckDeps): Promise<CheckResult> {
  const nonce = input.trim()
  const transfers = await readCircle(nonce, deps.fetchImpl)

  const circle = transfers
    ? [circleLine(transfers.length), ...transfers.flatMap((t) => [t.status, amountLine(t.amount)])]
    : [COULD_NOT_READ_CIRCLE]

  if (isPreEvent(nonce)) return { circle, arkiv: ARKIV_NOT_USED }

  const known = deps.knownTransferId ? [deps.knownTransferId] : null
  const ids = transfers?.length ? transfers.map((t) => t.id) : (known ?? (transfers ? [] : null))
  return { circle, arkiv: await arkivResult(ids, deps) }
}
