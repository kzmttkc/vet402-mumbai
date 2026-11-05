import type { GatewayClient } from '@circle-fin/x402-batching/client'
import type { Hex } from 'viem'
import { formatUsdc } from '../src/onchain-money'
import { readComparison, readOnePayment } from './circleRecord'
import { DemoError } from './demo'
import type { DemoPorts } from './demo'
import { preparePayment } from './gatewayPay'
import { DEMO_PRICE } from './sellers'

const GROW_ATTEMPTS = 30
const GROW_DELAY_MS = 2000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface Options {
  /** The hold key. It is the agent's only spending wallet. */
  holdKey: Hex
  holdClient: GatewayClient
  buyerClient: GatewayClient
}

export function createDemoPorts({ holdKey, holdClient, buyerClient }: Options): DemoPorts {
  const holdAvailable = async () => (await holdClient.getBalances()).gateway.available

  return {
    holdAvailable,

    async growHold(amount) {
      if ((await buyerClient.getBalances()).wallet.balance < amount) throw new DemoError('LOW_BALANCE')
      const before = await holdAvailable()
      await buyerClient.depositFor(formatUsdc(amount), holdClient.address)
      // The deposit counts once Gateway shows it as spendable.
      for (let attempt = 0; attempt < GROW_ATTEMPTS; attempt++) {
        if ((await holdAvailable()) >= before + amount) return
        await sleep(GROW_DELAY_MS)
      }
      throw new Error('The extra hold did not show up in time')
    },

    async prepare(sellerUrl) {
      const challenge = await preparePayment({ holdKey, holdAvailable }, { url: sellerUrl, method: 'GET' }, DEMO_PRICE)
      if (challenge.kind === 'free') throw new Error('The seller did not ask for a payment')
      return challenge.payment
    },

    async confirmOnePayment(nonce, expected) {
      return (await readOnePayment(nonce, expected)).ok
    },

    countPayments: (payer, seller, nonces) => readComparison(payer, seller, nonces),
  }
}
