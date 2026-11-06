// What the person keeps in this browser for "Ask the agent": the limit they chose, and what the agent bought here.
// Both live in localStorage only. A private window, blocked storage or a broken entry gives the defaults, never an error.

/** The limits the person can pick, in USDC. The last is the server's own limit, the most any job may cost. */
export const LIMIT_CHOICES = ['0.001', '0.005', '0.01'] as const
export type LimitChoice = (typeof LIMIT_CHOICES)[number]
export const DEFAULT_LIMIT: LimitChoice = '0.01'

/** At most this many purchases are kept, newest first. */
export const MAX_PURCHASES = 10
const MAX_LINE_CHARS = 120

const LIMIT_KEY = 'vet402.agent.limit'
const PURCHASES_KEY = 'vet402.agent.purchases'

/** One purchase the agent made from this browser. */
export interface Purchase {
  sellerName: string
  /** USDC, as a decimal string. */
  amount: string
  /** The answer, cut to one short line. */
  line: string
  /** When it was bought, in ms. */
  at: number
}

/** The part of Storage this file uses, so tests can pass their own. */
export type KeyStore = Pick<Storage, 'getItem' | 'setItem'>

function browserStore(): KeyStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function read(key: string, store: KeyStore | null): string | null {
  try {
    return store?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string, store: KeyStore | null): void {
  try {
    store?.setItem(key, value)
  } catch {
    // Storage is full or blocked. The page still works, it only forgets.
  }
}

const isChoice = (value: unknown): value is LimitChoice => LIMIT_CHOICES.includes(value as LimitChoice)

/** The limit the person chose here before, or the default. */
export function loadLimit(store: KeyStore | null = browserStore()): LimitChoice {
  const saved = read(LIMIT_KEY, store)
  return isChoice(saved) ? saved : DEFAULT_LIMIT
}

export function saveLimit(limit: LimitChoice, store: KeyStore | null = browserStore()): void {
  write(LIMIT_KEY, limit, store)
}

/** The answer as one short line. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS - 1)}…` : flat
}

const isPurchase = (p: unknown): p is Purchase => {
  const r = p as Partial<Purchase> | null
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.sellerName === 'string' &&
    typeof r.amount === 'string' &&
    typeof r.line === 'string' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at)
  )
}

/** What the agent bought from this browser, newest first. */
export function loadPurchases(store: KeyStore | null = browserStore()): Purchase[] {
  try {
    const parsed = JSON.parse(read(PURCHASES_KEY, store) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isPurchase)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_PURCHASES)
  } catch {
    return []
  }
}

/** Adds one purchase and returns the list as it is now. Something that charged nothing is not a purchase. */
export function addPurchase(purchase: Purchase, store: KeyStore | null = browserStore()): Purchase[] {
  const before = loadPurchases(store)
  if (!(Number(purchase.amount) > 0)) return before
  const list = [{ ...purchase, line: oneLine(purchase.line) }, ...before].sort((a, b) => b.at - a.at).slice(0, MAX_PURCHASES)
  write(PURCHASES_KEY, JSON.stringify(list), store)
  return list
}
