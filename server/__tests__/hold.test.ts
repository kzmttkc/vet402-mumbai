import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHoldService, HoldError } from '../hold'
import type { HoldPorts } from '../hold'
import { createHoldStore } from '../holdStore'

// Every test works inside its own temporary folder. Nothing here touches the app's data folder or .env.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'hold-test-'))
  expect(realpathSync(dir).startsWith(realpathSync(os.tmpdir()))).toBe(true)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const usdc = (value: number) => BigInt(Math.round(value * 1_000_000))

interface FakeOptions {
  buyer?: bigint
  holdWallet?: bigint
  holdAvailable?: bigint
  reserve?: bigint
  withdrawWorks?: boolean
  depositFails?: boolean
}

function fakePorts(options: FakeOptions = {}) {
  const state = {
    buyer: options.buyer ?? usdc(100),
    wallet: options.holdWallet ?? 0n,
    available: options.holdAvailable ?? 0n,
  }
  const calls: string[] = []

  const ports: HoldPorts = {
    buyerWallet: () => Promise.resolve(state.buyer),
    hold: () => Promise.resolve({ wallet: state.wallet, available: state.available }),
    gasReserve: () => Promise.resolve(options.reserve ?? usdc(0.1)),
    fundHoldWallet: (amount) => {
      calls.push('fund')
      state.buyer -= amount
      state.wallet += amount
      return Promise.resolve()
    },
    withdrawToBuyer: (amount) => {
      calls.push('withdraw')
      if (options.withdrawWorks !== false) {
        state.available -= amount
        state.buyer += amount
      }
      return Promise.resolve()
    },
    sweepToBuyer: () => {
      calls.push('sweep')
      state.buyer += state.wallet
      state.wallet = 0n
      return Promise.resolve()
    },
    depositForHold: (amount) => {
      calls.push('deposit')
      if (options.depositFails) return Promise.reject(new Error('rpc down'))
      state.buyer -= amount
      state.available += amount
      return Promise.resolve()
    },
  }
  return { ports, state, calls }
}

describe('starting a hold', () => {
  test('puts exactly the chosen amount on hold', async () => {
    const { ports, state, calls } = fakePorts()
    const holds = createHoldService(ports, createHoldStore(dir))

    await holds.start(usdc(5))

    expect(calls).toEqual(['deposit'])
    expect(state.available).toBe(usdc(5))
    expect(state.buyer).toBe(usdc(95))
  })

  test('sends Gateway leftovers back to the buyer before depositing', async () => {
    const { ports, state, calls } = fakePorts({ holdAvailable: usdc(2), buyer: usdc(10) })
    const holds = createHoldService(ports, createHoldStore(dir))

    await holds.start(usdc(3))

    expect(calls).toEqual(['fund', 'withdraw', 'sweep', 'deposit'])
    expect(state.available).toBe(usdc(3))
    expect(state.wallet).toBe(0n)
    expect(state.buyer).toBe(usdc(9))
  })

  test('skips the gas top-up when the hold wallet can already pay', async () => {
    const { ports, calls } = fakePorts({ holdAvailable: usdc(2), holdWallet: usdc(1) })
    const holds = createHoldService(ports, createHoldStore(dir))

    await holds.start(usdc(3))

    expect(calls).toEqual(['withdraw', 'sweep', 'deposit'])
  })

  test('sends loose wallet funds back before depositing', async () => {
    const { ports, state, calls } = fakePorts({ holdWallet: usdc(4) })
    const holds = createHoldService(ports, createHoldStore(dir))

    await holds.start(usdc(1))

    expect(calls).toEqual(['sweep', 'deposit'])
    expect(state.available).toBe(usdc(1))
  })

  test('does not deposit when the leftover could not be returned', async () => {
    const { ports, calls } = fakePorts({ holdAvailable: usdc(2), withdrawWorks: false })
    const store = createHoldStore(dir)
    const holds = createHoldService(ports, store)

    await expect(holds.start(usdc(3))).rejects.toMatchObject({ code: 'LEFTOVER_NOT_RETURNED' })

    expect(calls).not.toContain('deposit')
    expect(store.read()).toBeNull()
  })

  test('refuses when the buyer cannot cover the amount', async () => {
    const { ports, calls } = fakePorts({ buyer: usdc(1) })
    const store = createHoldStore(dir)
    const holds = createHoldService(ports, store)

    await expect(holds.start(usdc(5))).rejects.toMatchObject({ code: 'NOT_ENOUGH_BALANCE' })

    expect(calls).toEqual([])
    expect(store.read()).toBeNull()
  })

  test('refuses zero', async () => {
    const holds = createHoldService(fakePorts().ports, createHoldStore(dir))
    await expect(holds.start(0n)).rejects.toBeInstanceOf(HoldError)
  })

  test('forgets the hold when the deposit fails', async () => {
    const { ports } = fakePorts({ depositFails: true })
    const store = createHoldStore(dir)
    const holds = createHoldService(ports, store)

    await expect(holds.start(usdc(2))).rejects.toThrow('rpc down')

    expect(store.read()).toBeNull()
  })

  test('allows one hold at a time', async () => {
    const { ports } = fakePorts()
    const holds = createHoldService(ports, createHoldStore(dir))

    const first = holds.start(usdc(1))
    await expect(holds.start(usdc(1))).rejects.toMatchObject({ code: 'BUSY' })
    await first
  })
})

describe('hold status', () => {
  test('is none before any hold', async () => {
    const holds = createHoldService(fakePorts().ports, createHoldStore(dir))
    expect((await holds.status()).state).toBe('none')
  })

  test('is active with the amount left', async () => {
    const { ports, state } = fakePorts()
    const holds = createHoldService(ports, createHoldStore(dir))
    await holds.start(usdc(5))
    state.available = usdc(3.5)

    expect(await holds.status()).toEqual({ state: 'active', amount: '5', remaining: '3.5' })
  })

  test('is not used up before the hold has been seen with funds', async () => {
    const { ports, state } = fakePorts()
    const holds = createHoldService(ports, createHoldStore(dir))
    await holds.start(usdc(5))
    state.available = 0n // the deposit has not shown up yet

    expect((await holds.status()).state).toBe('setting-up')
  })

  test('is used up once the funded hold reaches zero', async () => {
    const { ports, state } = fakePorts()
    const holds = createHoldService(ports, createHoldStore(dir))
    await holds.start(usdc(5))
    await holds.status() // seen funded
    state.available = 0n

    expect((await holds.status()).state).toBe('used-up')
  })
})

describe('storage', () => {
  test('writes only inside the folder it was given', async () => {
    const { ports } = fakePorts()
    const holds = createHoldService(ports, createHoldStore(dir))
    await holds.start(usdc(1))

    expect(readdirSync(dir)).toEqual(['hold.json'])
  })

  test('does not load the app .env', () => {
    expect(process.env.BUYER_PRIVATE_KEY).toBeUndefined()
    expect(process.env.HOLD_PRIVATE_KEY).toBeUndefined()
  })
})
