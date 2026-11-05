// The smallest sealed seller: an Express route with SealedDelivery in front of it.
import express from 'express'
import type { Address, Hex } from 'viem'
import { sealedDelivery } from '../src/index'
import type { Facilitator, PaymentRequirement } from '../src/index'

export interface SellerConfig {
  contract: Address
  sellerKey: Hex
  rpcUrl: string
  facilitator: Facilitator
  accepts: PaymentRequirement
  watch?: boolean
}

export function createSellerApp(config: SellerConfig) {
  const app = express()
  const sealed = sealedDelivery(config)
  app.use('/forecast', sealed)
  app.get('/forecast', (_req, res) => res.json({ city: 'Mumbai', forecast: 'Sunny, 31 C' }))
  return { app, close: sealed.close }
}
