// Any x402 buyer can read vet402's rulings before it pays: one Arkiv query by the seller's payTo address.
// The query and the 7 day window are the ones vet402's own delivery check uses (server/arkiv.ts).
// It is plain JSON-RPC over fetch, with no key, no wallet and no extra dependency.

/** Arkiv's testnet, where vet402 writes its `vet402_verdict` entities. The public endpoint needs no key. */
export const ARKIV_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network'
/** A ruling stops payment to that address for this long, counted from the Arkiv block it was written in. */
export const RULING_SECONDS = 604_800
const PAGE = 100
const MAX_PAGES = 20
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export interface RulingOptions {
  /** The writer whose rulings you trust, for example vet402's `0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5`. Only its entities count. */
  writer: string
  /** Another Arkiv endpoint, such as one with your own access key in its path. */
  rpcUrl?: string
  /** How far back a ruling counts. Defaults to 7 days. */
  withinSeconds?: number
  fetch?: typeof fetch
}

/** The query string, so a buyer can run the same thing by hand with `arkiv_query`. */
export function rulingQuery(payTo: string, writer: string): string {
  if (!ADDRESS.test(payTo) || !ADDRESS.test(writer)) throw new Error('payTo and writer must be 0x addresses')
  return `arkiv.schema = str('vet402_verdict') AND kind = str('verdict') AND seller = str('${payTo.toLowerCase()}') AND $owner = addr(${writer})`
}

async function call<T>(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`Arkiv answered ${res.status}`)
  const body = (await res.json()) as { result?: T; error?: { message?: string } }
  if (body.error || body.result === undefined) throw new Error(`Arkiv refused ${method}: ${body.error?.message ?? 'no result'}`)
  return body.result
}

/**
 * True when the writer recorded a Silent or Fraud ruling from the SealedDelivery contract against this
 * payTo address within the window. A failed read throws, so the caller decides whether to pay without it.
 * vet402 itself does not pay when the read fails.
 */
export async function isRuledAgainst(payTo: string, options: RulingOptions): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch
  const url = options.rpcUrl ?? ARKIV_RPC
  const query = rulingQuery(payTo, options.writer)
  const timing = await call<{ current_block: number; duration: number }>(fetchImpl, url, 'arkiv_getBlockTiming', [])
  const within = BigInt(options.withinSeconds ?? RULING_SECONDS)
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call<{ data?: { createdAt?: string }[] }>(fetchImpl, url, 'arkiv_query', [
      query,
      { select: { key: true, createdAt: true }, limit: `0x${PAGE.toString(16)}`, offset: `0x${(page * PAGE).toString(16)}` },
    ])
    const rows = result.data ?? []
    for (const row of rows) {
      if (!row.createdAt) continue
      const age = (BigInt(timing.current_block) - BigInt(row.createdAt)) * BigInt(timing.duration)
      if (age < within) return true
    }
    if (rows.length < PAGE) return false
  }
  throw new Error(`More than ${MAX_PAGES * PAGE} rulings. Not all were read.`)
}
