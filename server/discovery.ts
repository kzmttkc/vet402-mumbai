import { CIRCLE_BATCHING_NAME } from '@circle-fin/x402-batching'

const DISCOVERY_URL = 'https://api.circle.com/v2/x402/discovery/resources'
const PAGE_SIZE = 200
// Safety stop so a misbehaving catalog can never keep us paging forever.
const MAX_PAGES = 10

/** A resource the agent could use for a job and pay for with Gateway. */
export interface Candidate {
  resource: string
  method: 'GET' | 'POST'
  sellerName: string
  category: string
  /** Price in atomic USDC units, from the Gateway payment option the agent would use. */
  amount: bigint
  /** The listing's request path, e.g. "/arc-testnet". */
  path: string
  /** Request body schema from the listing, when it has one. */
  bodySchema: BodySchema | null
  /** The seller's payee on this network, from the payment option the agent would use. */
  payTo: string | null
  /**
   * The SealedDelivery contract the listing says it answers under, when it says so. Only a seller
   * that seals can be checked for deposit cover, so this is null for every ordinary listing.
   */
  sealedBy: string | null
  /**
   * True only for vet402's own seller, which the agent adds beside the catalog. A Discovery
   * listing never has it, so nothing in the catalog can pass as vet402's own.
   */
  own?: boolean
  /**
   * Lowercase text used ONLY to match a job to a listing. It comes from the
   * listing's own words, so it is never shown to the user.
   */
  matchText: string
}

export interface BodySchema {
  required: string[]
  properties: string[]
}

interface RawAccept {
  scheme?: string
  network?: string
  amount?: string
  payTo?: string
  extra?: { name?: string; sealedDelivery?: unknown }
}

interface RawListing {
  resource?: string
  type?: string
  accepts?: RawAccept[]
  metadata?: {
    provider?: { name?: string; description?: string; category?: string; tags?: string[] }
    path?: string
    method?: string
    description?: string
    input?: { body?: { required?: unknown; properties?: unknown } }
    // siwx is deliberately ignored: listings that need it still take a plain payment.
    siwx?: boolean
  }
}

interface DiscoveryPage {
  items?: RawListing[]
  pagination?: { total?: number }
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** Turns one catalog listing into a candidate, or null when it cannot be paid for the way we need. */
export function toCandidate(item: RawListing, network: string): Candidate | null {
  if (item.type !== 'http' || typeof item.resource !== 'string') return null

  const method = item.metadata?.method?.toUpperCase()
  if (method !== 'GET' && method !== 'POST') return null

  const accept = item.accepts?.find(
    (a) => a.network === network && a.extra?.name === CIRCLE_BATCHING_NAME && typeof a.amount === 'string',
  )
  if (!accept?.amount || !/^\d+$/.test(accept.amount)) return null

  const provider = item.metadata?.provider
  const sellerName = provider?.name?.trim()
  if (!sellerName) return null

  const body = item.metadata?.input?.body
  const bodySchema: BodySchema | null = body
    ? {
        required: strings(body.required),
        properties:
          body.properties && typeof body.properties === 'object' ? Object.keys(body.properties as object) : [],
      }
    : null

  const matchText = [
    sellerName,
    provider?.description,
    provider?.category,
    ...(provider?.tags ?? []),
    item.metadata?.path,
    item.metadata?.description,
  ]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase()

  return {
    resource: item.resource,
    method,
    sellerName,
    category: provider?.category ?? '',
    amount: BigInt(accept.amount),
    payTo: typeof accept.payTo === 'string' && ADDRESS.test(accept.payTo) ? accept.payTo : null,
    sealedBy:
      typeof accept.extra?.sealedDelivery === 'string' && ADDRESS.test(accept.extra.sealedDelivery)
        ? accept.extra.sealedDelivery
        : null,
    path: item.metadata?.path ?? '',
    bodySchema,
    matchText,
  }
}

/**
 * Asks the Discovery API for everything payable on the network and keeps what
 * takes a Gateway batched payment there. The siwx filter is never sent: POST
 * listings and listings that mention siwx stay in as candidates.
 */
export async function fetchCandidates(network: string, fetchImpl: FetchLike = fetch): Promise<Candidate[]> {
  const candidates: Candidate[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      network,
      type: 'http',
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    })
    const res = await fetchImpl(`${DISCOVERY_URL}?${params.toString()}`)
    if (!res.ok) throw new Error(`Discovery failed with status ${res.status}`)

    const body = (await res.json()) as DiscoveryPage
    const items = body.items ?? []
    for (const item of items) {
      const candidate = toCandidate(item, network)
      if (candidate) candidates.push(candidate)
    }

    const total = body.pagination?.total ?? 0
    if (items.length === 0 || (page + 1) * PAGE_SIZE >= total) break
  }

  return candidates
}
