import { GATEWAY_DOMAINS } from '@circle-fin/x402-batching/client'
import type { Address } from 'viem'
import { ARC_GATEWAY_API } from '../src/existing/arc-gateway'
import { formatUsdc, parseUsdc } from '../src/onchain-money'
import { createOwnSealedSeller, ownCandidate, ownListing } from './paymentCheckSeller'
import type { OwnSealedSeller, OwnSellerOptions, OwnSellerSpec } from './paymentCheckSeller'

// vet402 Balance Check: vet402's second own seller, made the same way as Payment Check. Same seller wallet, same
// SealedDelivery contract, same price and the same protection. It reads the payer's Circle Gateway balance on Arc
// by address, as Circle's balances API gives it to anyone, and answers in plain words.

export const BALANCE_CHECK_NAME = 'vet402 Balance Check'
/** Never fetched: the agent buys this seller on 127.0.0.1. The reserved .invalid name means a slip reaches nobody. */
export const BALANCE_CHECK_RESOURCE = 'https://vet402.invalid/sellers/balance-check'

const BALANCE_CHECK: OwnSellerSpec = {
  name: BALANCE_CHECK_NAME,
  resource: BALANCE_CHECK_RESOURCE,
  path: '/balance-check',
  description: 'Tells you how much USDC your agent has to spend, from its Circle Gateway balance on Arc. Protected on Arc by SealedDelivery.',
  summary: "Reads your agent's Circle Gateway balance and sends the answer sealed on Arc.",
}

const READ_TIMEOUT_MS = 10_000

export const balanceCheckListing = (payTo: Address, sealedAddress: Address) => ownListing(BALANCE_CHECK, payTo, sealedAddress)

export const balanceCheckCandidate = (payTo: Address, sealedAddress: Address) => ownCandidate(BALANCE_CHECK, payTo, sealedAddress)

/**
 * The answer in plain words, from what the agent can spend through Circle Gateway and what this check costs, in atomic
 * USDC units. The seller reads the balance before it settles the check, so the check's own price is taken off here.
 */
export function describeBalance(available: bigint, thisCheck = 0n): string {
  const left = available > thisCheck ? available - thisCheck : 0n
  if (left === 0n) return 'Your agent has no USDC left to spend after this check. Its Circle Gateway balance on Arc is empty.'
  return `Your agent has ${formatUsdc(left)} USDC left to spend after this check, in its Circle Gateway balance on Arc.`
}

/** POST {Gateway API}/balances for one depositor on Arc. What it can spend, in atomic USDC units. */
export async function gatewayBalance(depositor: string, fetchImpl: typeof fetch = fetch): Promise<bigint> {
  const res = await fetchImpl(`${ARC_GATEWAY_API}/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor, domain: GATEWAY_DOMAINS.arcTestnet }] }),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Circle balance read failed with status ${res.status}`)
  const body = (await res.json()) as { balances?: { domain?: unknown; balance?: unknown }[] } | null
  const row = body?.balances?.find((b) => b.domain === GATEWAY_DOMAINS.arcTestnet)
  if (typeof row?.balance !== 'string') throw new Error('Circle returned no balance for this wallet')
  return parseUsdc(row.balance)
}

/** Reads the payer's Gateway balance from Circle and answers, with this check's price taken off. */
export async function balanceFromCircle(payer: string, thisCheck: bigint, fetchImpl: typeof fetch = fetch): Promise<string> {
  return describeBalance(await gatewayBalance(payer, fetchImpl), thisCheck)
}

export interface BalanceCheckOptions extends OwnSellerOptions {
  /** The answer for a payer and this check's price. Defaults to Circle's balances API. */
  balance?: (payer: string, thisCheck: bigint) => Promise<string>
}

export function createBalanceCheck(options: BalanceCheckOptions): OwnSealedSeller {
  const read = options.balance ?? ((payer: string, thisCheck: bigint) => balanceFromCircle(payer, thisCheck))
  return createOwnSealedSeller(BALANCE_CHECK, (payment) => read(payment.from, BigInt(payment.value)), options)
}
