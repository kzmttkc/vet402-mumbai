import { formatUsdc } from '../src/onchain-money'
import type { Candidate } from './discovery'

// How the agent picks a seller. It scores every listing in the catalog against the job with BM25
// (plain word statistics, no language model and no outside service), drops what it may not pay
// for, and asks before it spends on the best one that is left. Nothing here names a seller or a
// listing path: the catalog decides who is there, and the job's words decide who fits.

export interface PlannedRequest {
  url: string
  method: 'GET' | 'POST'
  body?: Record<string, unknown>
}

/** How the agent uses a listing. A JSON-RPC node checks a payment; anything else is bought as listed. */
export type Skill = 'payment-check' | 'lookup'

/** One listing the agent compared, as the card shows it. Our own words only, never the listing's text. */
export interface Compared {
  sellerName: string
  /** The listing's path, cut down to letters, digits and dashes. */
  listing: string
  /** USDC, as a decimal string. */
  amount: string
  note: string
  /** vet402's own seller, not a Discovery listing. The card marks it. */
  own?: true
}

export interface Plan {
  kind: 'receipt-check' | 'lookup'
  sellerName: string
  /** One plain sentence about the job. Written by us, never copied from a listing. */
  summary: string
  /** What the agent asks to spend, in atomic USDC units. */
  amount: bigint
  request: PlannedRequest
  /** One line on why this seller, e.g. "Picked from 134 Arc listings: best match for 'payment', 0.0001 USDC". Absent on a plan we wrote ourselves. */
  why?: string
  /** The top listings it compared, the picked one first. */
  compared?: Compared[]
  /** The pick is vet402's own seller, so the agent buys it from vet402 and not through the catalog. */
  own?: true
}

export type PlanFailure = 'EMPTY_JOB' | 'NO_SELLER' | 'OVER_LIMIT' | 'NO_PAYMENTS' | 'NOT_SETTLED'

export type PlanOutcome =
  | { ok: true; plan: Plan }
  | { ok: false; reason: PlanFailure; why?: string; compared?: Compared[] }

/** The newest row of the agent's payment history. `batchTx` is null until the payment is batched onchain. */
export interface LatestReceipt {
  batchTx: string | null
}

/** What the agent knows about a seller before it pays, from Arkiv and the deposit contract. */
export interface SellerSignal {
  /** Arkiv's delivery record: 'expired' means a past payment with no recent delivery, so it is not paid. */
  delivery?: 'live' | 'first' | 'expired' | 'busy'
  /** Only for a seller that seals: false when its deposit does not cover the price. */
  covered?: boolean | null
}

export interface AgentContext {
  /** The network the agent's own payments settle on, by name, e.g. "Arc Testnet". */
  networkName: string
  /** The most the agent may spend on one job, in atomic USDC units. */
  limit: bigint
  /** By seller name. */
  signals?: ReadonlyMap<string, SellerSignal>
}

export interface Ranked {
  candidate: Candidate
  skill: Skill
  score: number
  /** The job's own words that made the match, in the order the job has them. */
  matched: string[]
  /** Null when the agent cannot fill in the request this listing needs. */
  request: PlannedRequest | null
  /** Why it may not be picked. Null when it may. */
  blocked: Block | null
}

/** Why a listing that matched may not be paid. */
export type Block = 'weak' | 'details' | 'limit' | 'delivery' | 'deposit'

const BLOCK_NOTES: Record<Block, string> = {
  weak: 'Only a payment word matched',
  details: 'Needs details I can’t fill in',
  limit: 'Over the limit',
  delivery: 'No recent delivery',
  deposit: 'Deposit doesn’t cover it',
}

const BLOCK_SENTENCES: Record<Block, string> = {
  weak: 'matched only a payment word',
  details: 'needs details I can’t fill in',
  limit: 'asks more than I may spend',
  delivery: 'has no recent delivery',
  deposit: 'has a deposit that doesn’t cover this',
}

/** The stock sentence every "nobody" answer starts with. */
export const NO_SELLER_SENTENCE = 'I couldn’t find anyone who can do this job.'

export interface Ranking {
  /** How many listings the catalog had. vet402's own seller is not one of them. */
  total: number
  /** True when vet402's own seller was ranked beside the catalog. */
  withOwn?: true
  networkName: string
  limit: bigint
  signals?: ReadonlyMap<string, SellerSignal>
  /** Every listing that matched the job at all, best first. */
  ranked: Ranked[]
  /** The best listing the agent may pay, or null. */
  pick: Ranked | null
}

// Words that say nothing about which seller fits.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'whats', 'how', 'can', 'you', 'please', 'need', 'want',
  'get', 'give', 'show', 'tell', 'about', 'from', 'have', 'has', 'was', 'were', 'are', 'did', 'does', 'would',
  'could', 'should', 'into', 'out', 'any', 'all', 'but', 'not', 'there', 'their', 'them', 'then', 'than',
  'find', 'check', 'look', 'make', 'me', 'my', 'our', 'your', 'its', 'job', 'today', 'now', 'just', 'some',
  'one', 'will', 'who', 'why', 'when', 'where', 'which', 'yes', 'is', 'it', 'of', 'to', 'in', 'on', 'a', 'an',
])

// What the payment check is for, in our words. A job must share at least one of them.
// The first ones are the nouns the card quotes back.
const PAYMENT_CHECK_WORDS = [
  'payment', 'pay', 'paid', 'transaction', 'transfer', 'settlement', 'settle', 'settled', 'confirm',
  'confirmed', 'arrive', 'arrived', 'succeed', 'succeeded', 'fail', 'failed', 'through', 'went', 'gone',
]

// Request fields where the job text can go as-is.
const TEXT_FIELDS = ['query', 'q', 'prompt', 'text', 'question', 'message', 'input', 'search', 'topic']

// Written by us so a listing's own words never reach the screen.
const SUMMARIES: Record<string, string> = {
  SOCIAL_INTELLIGENCE: 'Looks up social data to help with this job.',
  FINANCIAL_ANALYSIS: 'Looks up market data to help with this job.',
  WEB_SEARCH_RESEARCH: 'Searches the web to help with this job.',
  PREDICTION_MARKETS: 'Looks up forecast data to help with this job.',
  CREATIVE: 'Creates something for this job.',
  INFRASTRUCTURE: 'Runs a technical lookup for this job.',
}
const DEFAULT_SUMMARY = 'Takes care of this job for you.'
const RECEIPT_SUMMARY = 'Checks whether your latest payment went through.'
const OWN_SUMMARY = "Reads Circle's record of your agent's last payment and sends the answer sealed on Arc."

// BM25's usual constants.
const K1 = 1.2
const B = 0.75
/** A payment check gets this much for a job that is only about payments, less as the job says other things. */
const PAYMENT_CHECK_WEIGHT = 6
/** Small nudges, so they only break near ties. */
const LIVE_BONUS = 0.5
const COVERED_BONUS = 0.5
const COMPARED = 3

const TX_HASH = /^0x[0-9a-fA-F]{64}$/

/** Resource URLs come from a public catalog, so only plain https hostnames are ever called. */
export function isSafeResource(resource: string): boolean {
  let url: URL
  try {
    url = new URL(resource)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false
  }
  // IP addresses (v4 or v6) are never expected from a real seller.
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return false
  return host.includes('.')
}

/** A light stemmer, so "payment", "payments" and "pay" meet. Both sides go through it, so it only has to be consistent. */
export function stem(word: string): string {
  let w = word
  for (const suffix of ['ments', 'ment', 'ings', 'ing', 'ed', 'es', 's']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length)
      break
    }
  }
  return w.length > 3 && w.endsWith('e') ? w.slice(0, -1) : w
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? []

/** The job's words that count, stemmed, each with the first spelling the job used. */
function jobTerms(job: string): Map<string, string> {
  const terms = new Map<string, string>()
  for (const word of words(job)) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue
    const s = stem(word)
    if (!terms.has(s)) terms.set(s, word)
  }
  return terms
}

const PAYMENT_CHECK = PAYMENT_CHECK_WORDS.map(stem)

/** The listing as a bag of stemmed words. The path is split on dashes and slashes, so each word of it counts. */
function docTerms(candidate: Candidate): string[] {
  return words(candidate.matchText).map(stem)
}

interface Corpus {
  docs: Map<Candidate, Map<string, number>>
  lengths: Map<Candidate, number>
  df: Map<string, number>
  avgLength: number
  n: number
}

function corpus(candidates: Candidate[]): Corpus {
  const docs = new Map<Candidate, Map<string, number>>()
  const lengths = new Map<Candidate, number>()
  const df = new Map<string, number>()
  let totalLength = 0
  for (const candidate of candidates) {
    const terms = docTerms(candidate)
    const tf = new Map<string, number>()
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)
    docs.set(candidate, tf)
    lengths.set(candidate, terms.length)
    totalLength += terms.length
  }
  return { docs, lengths, df, avgLength: candidates.length ? totalLength / candidates.length : 0, n: candidates.length }
}

/** BM25 of the query terms against one listing, and which terms hit. */
function bm25(c: Corpus, candidate: Candidate, query: Iterable<string>): { score: number; hits: string[] } {
  const tf = c.docs.get(candidate)
  const length = c.lengths.get(candidate) ?? 0
  let score = 0
  const hits: string[] = []
  if (!tf) return { score, hits }
  for (const term of query) {
    const f = tf.get(term) ?? 0
    if (f === 0) continue
    const df = c.df.get(term) ?? 0
    const idf = Math.log(1 + (c.n - df + 0.5) / (df + 0.5))
    score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * length) / (c.avgLength || 1)))
    hits.push(term)
  }
  return { score, hits }
}

/** A JSON-RPC node, known by the request its listing asks for, not by its name or path. */
function isJsonRpc(candidate: Candidate): boolean {
  const required = candidate.bodySchema?.required ?? []
  return candidate.method === 'POST' && required.includes('jsonrpc') && required.includes('method')
}

/** Builds the request for a general job, or null when the listing asks for fields we cannot fill. */
function genericRequest(candidate: Candidate, job: string): PlannedRequest | null {
  if (candidate.method === 'GET') return { url: candidate.resource, method: 'GET' }

  const schema = candidate.bodySchema
  const body: Record<string, unknown> = {}
  const textField = TEXT_FIELDS.find((f) => schema?.properties.includes(f))
  if (textField) body[textField] = job

  if (schema && !schema.required.every((field) => field in body)) return null
  return { url: candidate.resource, method: 'POST', body }
}

const usdc = (amount: bigint) => formatUsdc(amount)

/** The listing's path as a short label. A catalog can say anything, so only plain characters pass. */
export function listingLabel(candidate: Candidate): string {
  return candidate.path
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '/')
    .slice(0, 32)
}

/** Scores closer than this are the same score apart from rounding, so the cheaper listing goes first, whatever else is in the pool. */
const SCORE_TIE = 1e-9

const byScore = (a: Ranked, b: Ranked) =>
  (Math.abs(b.score - a.score) > SCORE_TIE ? b.score - a.score : 0) ||
  (a.candidate.amount < b.candidate.amount ? -1 : a.candidate.amount > b.candidate.amount ? 1 : 0) ||
  a.candidate.resource.localeCompare(b.candidate.resource)

/**
 * Scores every listing against the job. A listing can be used two ways, and it keeps the better:
 * - payment check: the job is about a payment, and the listing is a JSON-RPC node on the network
 *   the agent's own payments settle on. The node is found by that network's name in the listing.
 * - lookup: the listing's own words match the job, and the agent can fill in its request.
 */
export function rankJob(job: string, candidates: Candidate[], ctx: AgentContext): Ranking {
  const text = job.trim()
  const terms = jobTerms(text)
  const safe = candidates.filter((c) => isSafeResource(c.resource))
  const c = corpus(safe)

  const paymentHits = [...terms.keys()].filter((t) => PAYMENT_CHECK.includes(t))
  // The card quotes the payment word first: "payment", not "through".
  const paymentQuoted = [...paymentHits].sort((a, b) => PAYMENT_CHECK.indexOf(a) - PAYMENT_CHECK.indexOf(b)).slice(0, 1)
  const paymentShare = terms.size ? paymentHits.length / terms.size : 0
  const networkTerms = [...new Set(words(ctx.networkName).map(stem))]

  const ranked: Ranked[] = []
  for (const candidate of safe) {
    const options: (Omit<Ranked, 'blocked'> & { weak?: boolean })[] = []

    if (paymentHits.length > 0 && isJsonRpc(candidate)) {
      const onNetwork = bm25(c, candidate, networkTerms)
      // Every word of the network's name has to be there, so a node for another chain never checks an Arc payment.
      if (networkTerms.length > 0 && onNetwork.hits.length === networkTerms.length) {
        options.push({
          candidate,
          skill: 'payment-check',
          score: PAYMENT_CHECK_WEIGHT * paymentShare + onNetwork.score,
          matched: paymentQuoted.map((t) => terms.get(t) as string),
          // Filled in once the agent has read its latest payment.
          request: null,
        })
      }
    }

    const lookup = bm25(c, candidate, terms.keys())
    if (lookup.score > 0) {
      options.push({
        candidate,
        skill: 'lookup',
        score: lookup.score,
        matched: lookup.hits.map((t) => terms.get(t) as string),
        request: genericRequest(candidate, text),
        // "Did my payment go through?" must not buy whatever lists the word "payments".
        weak: lookup.hits.every((t) => PAYMENT_CHECK.includes(t)),
      })
    }

    const best = options.sort((a, b) => b.score - a.score)[0]
    if (!best) continue

    const signal = ctx.signals?.get(candidate.sellerName)
    let score = best.score
    if (signal?.delivery === 'live') score += LIVE_BONUS
    if (signal?.covered === true) score += COVERED_BONUS

    let blocked: Block | null = null
    if (best.weak) blocked = 'weak'
    else if (best.skill === 'lookup' && !best.request) blocked = 'details'
    else if (candidate.amount > ctx.limit) blocked = 'limit'
    else if (signal?.delivery === 'expired') blocked = 'delivery'
    else if (signal?.covered === false) blocked = 'deposit'

    const { weak: _weak, ...entry } = best
    ranked.push({ ...entry, score, blocked })
  }

  ranked.sort(byScore)
  return {
    total: candidates.filter((c) => !c.own).length,
    ...(candidates.some((c) => c.own) ? { withOwn: true as const } : {}),
    networkName: ctx.networkName,
    limit: ctx.limit,
    ...(ctx.signals ? { signals: ctx.signals } : {}),
    ranked,
    pick: ranked.find((r) => r.blocked === null) ?? null,
  }
}

const quoted = (matched: string[]) => `'${matched.slice(0, 3).join(' ')}'`

/** "Arc" from "Arc Testnet": the short name the card uses for where the catalog is. */
const placeName = (networkName: string) => networkName.split(/\s+/)[0] || networkName

function comparedOf(ranking: Ranking): Compared[] {
  return ranking.ranked.slice(0, COMPARED).map((r) => ({
    sellerName: r.candidate.sellerName,
    listing: listingLabel(r.candidate),
    amount: usdc(r.candidate.amount),
    note: r === ranking.pick ? 'Picked' : r.blocked ? BLOCK_NOTES[r.blocked] : 'Lower match',
    ...(r.candidate.own ? { own: true as const } : {}),
  }))
}

const deliveryWords: Record<NonNullable<SellerSignal['delivery']>, string | null> = {
  live: 'delivered recently',
  first: 'first purchase from this seller',
  expired: null,
  busy: null,
}

/** The one line the card shows about the choice. */
export function whyLine(ranking: Ranking, pick: Ranked, signal?: SellerSignal): string {
  const parts = [`best match for ${quoted(pick.matched)}`, `${usdc(pick.candidate.amount)} USDC`]
  const delivered = signal?.delivery ? deliveryWords[signal.delivery] : null
  if (delivered) parts.push(delivered)
  if (signal?.covered === true) parts.push('its deposit covers it')
  const own = ranking.withOwn ? " and vet402's own seller" : ''
  return `Picked from ${ranking.total} ${placeName(ranking.networkName)} listings${own}: ${parts.join(', ')}`
}

/** Turns a ranking into a plan, or a reason the agent will not pay, in plain words. */
export function decide(job: string, ranking: Ranking, latest: LatestReceipt | null): PlanOutcome {
  const text = job.trim()
  if (!text) return { ok: false, reason: 'EMPTY_JOB' }
  const compared = comparedOf(ranking)
  const place = placeName(ranking.networkName)

  const pick = ranking.pick
  if (!pick) {
    const top = ranking.ranked[0]
    if (!top) {
      return {
        ok: false,
        reason: 'NO_SELLER',
        why: `${NO_SELLER_SENTENCE} None of the ${ranking.total} ${place} listings matched. Nothing was paid.`,
        compared,
      }
    }
    if (top.blocked === 'limit') {
      return {
        ok: false,
        reason: 'OVER_LIMIT',
        why: `${top.candidate.sellerName} fits best but asks ${usdc(top.candidate.amount)} USDC, over the ${usdc(ranking.limit)} USDC limit. Nothing was paid.`,
        compared,
      }
    }
    const reason = BLOCK_SENTENCES[top.blocked ?? 'details']
    return {
      ok: false,
      reason: 'NO_SELLER',
      why: `${NO_SELLER_SENTENCE} The best of the ${ranking.total} ${place} listings, ${top.candidate.sellerName}, ${reason}. Nothing was paid.`,
      compared,
    }
  }

  const { candidate } = pick
  const why = whyLine(ranking, pick, ranking.signals?.get(candidate.sellerName))

  if (pick.skill === 'payment-check') {
    if (!latest) return { ok: false, reason: 'NO_PAYMENTS', why, compared }
    if (!latest.batchTx || !TX_HASH.test(latest.batchTx)) return { ok: false, reason: 'NOT_SETTLED', why, compared }
    return {
      ok: true,
      plan: {
        kind: 'receipt-check',
        sellerName: candidate.sellerName,
        summary: RECEIPT_SUMMARY,
        amount: candidate.amount,
        request: {
          url: candidate.resource,
          method: 'POST',
          // Exactly one receipt lookup, for the batch transaction of the latest receipt row.
          body: { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [latest.batchTx] },
        },
        why,
        compared,
      },
    }
  }

  return {
    ok: true,
    plan: {
      kind: 'lookup',
      sellerName: candidate.sellerName,
      summary: candidate.own ? OWN_SUMMARY : (SUMMARIES[candidate.category] ?? DEFAULT_SUMMARY),
      amount: candidate.amount,
      request: pick.request as PlannedRequest,
      why,
      compared,
      ...(candidate.own ? { own: true as const } : {}),
    },
  }
}

/** True when the agent's pick is a payment check, so it has to read its latest payment first. */
export const needsLatestPayment = (ranking: Ranking) => ranking.pick?.skill === 'payment-check'

/** Ranks and decides in one step, for callers that already have the latest payment. */
export function planJob(job: string, candidates: Candidate[], ctx: AgentContext, latest: LatestReceipt | null): PlanOutcome {
  const ranking = rankJob(job, candidates, ctx)
  return decide(job, ranking, latest)
}

/** The cheapest listing that can take this job, whatever its words say. Used by the Seller C scene. */
export function planCheapest(job: string, candidates: Candidate[]): PlanOutcome {
  const usable = candidates
    .filter((c) => isSafeResource(c.resource) && !isJsonRpc(c))
    .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))
  for (const candidate of usable) {
    const request = genericRequest(candidate, job)
    if (request) {
      return {
        ok: true,
        plan: {
          kind: 'lookup',
          sellerName: candidate.sellerName,
          summary: SUMMARIES[candidate.category] ?? DEFAULT_SUMMARY,
          amount: candidate.amount,
          request,
          why: `The cheapest listing that can take this job, ${usdc(candidate.amount)} USDC`,
          compared: [],
        },
      }
    }
  }
  return { ok: false, reason: 'NO_SELLER' }
}
