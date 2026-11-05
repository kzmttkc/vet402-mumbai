// Shared by the package tests: a chain client that never leaves memory, and a served Express app.
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type express from 'express'
import type { Address } from 'viem'
import type { SealedChain } from '../src/index'

export const CHAIN_ID = 31337
export const CONTRACT: Address = '0x00000000000000000000000000000000000000c0'
export const GATEWAY: Address = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
export const DOMAIN = { name: 'GatewayWalletBatched', version: '1', chainId: CHAIN_ID, verifyingContract: GATEWAY }

/** Only what the off-chain path reads. A chain call in these tests is a failure. */
export function offlineChain(): SealedChain {
  const refuse = () => {
    throw new Error('no chain in this test')
  }
  return new Proxy({ contract: CONTRACT, chainId: async () => CHAIN_ID } as Partial<SealedChain>, {
    get: (target, name) => (name in target ? target[name as keyof SealedChain] : refuse),
  }) as SealedChain
}

export function serve(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => {
          server.closeAllConnections?.()
          server.close()
        },
      }),
    )
  })
}

/** A JSON-RPC node with one empty block: enough for the chain id and a lookout that finds no claims. */
export function stubNode(): Promise<{ url: string; close: () => void }> {
  const answers: Record<string, unknown> = {
    eth_chainId: `0x${CHAIN_ID.toString(16)}`,
    eth_blockNumber: '0x1',
    eth_getLogs: [],
  }
  return import('express').then(({ default: express }) => {
    const app = express()
    app.use(express.json())
    app.post('/', (req, res) => {
      const { id, method } = req.body as { id: number; method: string }
      res.json(method in answers ? { jsonrpc: '2.0', id, result: answers[method] } : { jsonrpc: '2.0', id, error: { code: -32601, message: method } })
    })
    return serve(app)
  })
}
