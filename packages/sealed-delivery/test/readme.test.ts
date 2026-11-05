// Runs the README's first code block as written. Only the package name is pointed at this folder.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createLocalFacilitator, createLocalPayer } from '../examples/localPayment'
import type { PaymentRequirement } from '../src/index'
import { CHAIN_ID, CONTRACT, DOMAIN, serve, stubNode } from './helpers'

const PACKAGE = path.resolve(import.meta.dirname, '..')

function readmeExample(): { imports: string; body: string; lines: number } {
  const readme = readFileSync(path.join(PACKAGE, 'README.md'), 'utf8')
  const block = readme.split('<!-- readme-example -->')[1]?.match(/```ts\n([\s\S]*?)```/)?.[1]
  if (!block) throw new Error('No example block after <!-- readme-example --> in README.md')
  const lines = block.trim().split('\n')
  const imports = lines.filter((l) => l.startsWith('import ')).join('\n')
  const body = lines.filter((l) => !l.startsWith('import ')).join('\n')
  return { imports: imports.replace("'@vet402/sealed-delivery'", JSON.stringify(path.join(PACKAGE, 'src/index.ts'))), body, lines: lines.length - 1 }
}

describe('the README example', () => {
  test('is three lines and runs as written', async () => {
    const example = readmeExample()
    expect(example.lines).toBe(3)

    const sellerKey = generatePrivateKey()
    const buyerKey = generatePrivateKey()
    const accepts: PaymentRequirement = {
      scheme: 'exact',
      network: `eip155:${CHAIN_ID}`,
      asset: '0x3600000000000000000000000000000000000000',
      amount: '1000',
      payTo: privateKeyToAccount(sellerKey).address,
    }
    const { facilitator } = createLocalFacilitator(DOMAIN)
    const node = await stubNode()
    const app = express()
    const dir = mkdtempSync(path.join(tmpdir(), 'readme-example-'))
    const file = path.join(dir, 'example.ts')
    writeFileSync(
      file,
      `${example.imports}\nexport async function run(ctx: any) {\n  const { app, contract, sellerKey, facilitator, accepts, rpcUrl, buyerKey, paymentHeader, serve } = ctx\n${example.body.split('\n').slice(0, 2).join('\n')}\n  const url = (await serve(app)).url + '/answer'\n  ctx.url = url\n${example.body.split('\n').slice(2).join('\n')}\n  return text\n}\n`,
    )
    let close = () => {}
    try {
      const { run } = (await import(file)) as { run: (ctx: Record<string, unknown>) => Promise<string> }
      const text = await run({
        app,
        contract: CONTRACT,
        sellerKey,
        facilitator,
        accepts,
        rpcUrl: node.url,
        buyerKey,
        paymentHeader: await createLocalPayer(buyerKey, DOMAIN)(accepts),
        serve: async (a: express.Express) => {
          const s = await serve(a)
          close = s.close
          return s
        },
      })
      expect(JSON.parse(text)).toEqual({ answer: 42 })
    } finally {
      close()
      node.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
