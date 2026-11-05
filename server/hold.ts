import { formatUsdc } from '../src/onchain-money'
import type { HoldStore } from './holdStore'

/** Everything the hold logic needs from the outside world. Real versions live in ports.ts. */
export interface HoldPorts {
  /** USDC in the buyer's wallet. */
  buyerWallet(): Promise<bigint>
  /** What the hold key has: loose USDC in its wallet, and what it can spend through Gateway. */
  hold(): Promise<{ wallet: bigint; available: bigint }>
  /** How much USDC the hold wallet needs to pay for taking its Gateway balance out. */
  gasReserve(): Promise<bigint>
  /** Buyer sends USDC to the hold wallet. */
  fundHoldWallet(amount: bigint): Promise<void>
  /** Hold key moves its Gateway balance back to the buyer. */
  withdrawToBuyer(amount: bigint): Promise<void>
  /** Hold key sends everything in its wallet back to the buyer, keeping only what the transfer costs. */
  sweepToBuyer(): Promise<void>
  /** Buyer deposits into Gateway on behalf of the hold key. */
  depositForHold(amount: bigint): Promise<void>
}

export type HoldErrorCode = 'INVALID_AMOUNT' | 'NOT_ENOUGH_BALANCE' | 'BUSY' | 'LEFTOVER_NOT_RETURNED'

export class HoldError extends Error {
  readonly code: HoldErrorCode

  constructor(code: HoldErrorCode, message: string) {
    super(message)
    this.name = 'HoldError'
    this.code = code
  }
}

export interface HoldView {
  state: 'none' | 'setting-up' | 'active' | 'used-up'
  /** The amount the user chose to hold, in USDC. */
  amount: string
  /** What the agent can still spend, in USDC. */
  remaining: string
}

export function createHoldService(ports: HoldPorts, store: HoldStore) {
  let busy = false

  /** Brings the hold to exactly `amount` and returns what the buyer still has to deposit. */
  async function shortfallAfterLeftovers(amount: bigint): Promise<bigint> {
    const before = await ports.hold()

    // Taking money out of Gateway costs a fee, so a smaller leftover stays and only the difference is added.
    if (before.available > amount) {
      const reserve = await ports.gasReserve()
      if (before.wallet < reserve) await ports.fundHoldWallet(reserve - before.wallet)
      await ports.withdrawToBuyer(before.available - amount)
    }

    const mid = await ports.hold()
    if (mid.wallet > 0n) await ports.sweepToBuyer()

    const after = await ports.hold()
    if (after.available > amount) {
      throw new HoldError('LEFTOVER_NOT_RETURNED', 'The previous hold could not be returned yet.')
    }
    return amount - after.available
  }

  async function start(amount: bigint): Promise<void> {
    if (amount <= 0n) throw new HoldError('INVALID_AMOUNT', 'Enter an amount above zero.')
    if (busy) throw new HoldError('BUSY', 'A hold is already being set up.')

    busy = true
    try {
      // Until the new hold is funded, nothing should look active or used up.
      store.clear()

      // The hold is exactly the chosen amount, whatever was left from before.
      const shortfall = await shortfallAfterLeftovers(amount)

      if ((await ports.buyerWallet()) < shortfall) {
        throw new HoldError('NOT_ENOUGH_BALANCE', 'Your balance is too low for this hold.')
      }

      store.write({ amount: amount.toString(), seenFunded: false })
      if (shortfall === 0n) return
      try {
        await ports.depositForHold(shortfall)
      } catch (error) {
        store.clear()
        throw error
      }
    } finally {
      busy = false
    }
  }

  async function status(): Promise<HoldView> {
    if (busy) return { state: 'setting-up', amount: '0', remaining: '0' }

    const record = store.read()
    if (!record) return { state: 'none', amount: '0', remaining: '0' }

    const { available } = await ports.hold()
    const seenFunded = record.seenFunded || available > 0n
    if (seenFunded && !record.seenFunded) store.write({ amount: record.amount, seenFunded: true })

    const base = { amount: formatUsdc(BigInt(record.amount)), remaining: formatUsdc(available) }
    // Right after the deposit the balance can take a moment to show up. It only counts as used up once it has been seen.
    if (seenFunded && available === 0n) return { state: 'used-up', ...base }
    return { state: seenFunded ? 'active' : 'setting-up', ...base }
  }

  return { start, status }
}
