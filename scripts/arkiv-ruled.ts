// Reads only, with no key:
//   npx bun@1.3.14 run scripts/arkiv-ruled.ts <payTo>
//
// Asks Arkiv the question any x402 buyer asks before it pays: has Arc ruled against this payTo address in
// the last 7 days? It calls `isRuledAgainst` from `packages/sealed-delivery` with rulings from any writer,
// each counted only once Arc holds the contract's own Silent or Fraud event, and prints the answer with the
// newest claim behind it. Both reads go to the public endpoints of Arkiv's Rabdi testnet and Arc testnet.
// When Arkiv's public budget runs out (ANON_COST_LIMITED), ARKIV_ACCESS_KEY from https://hub.arkiv.network
// goes at the end of the URL path, as the README says. The key is never printed.
import { ARKIV_RPC, isRuledAgainst, RULING_SECONDS, rulingQuery } from '../packages/sealed-delivery/src/index'
import { rulingOnArc } from '../packages/sealed-delivery/src/rulings'

const [payTo] = process.argv.slice(2)
if (!/^0x[0-9a-fA-F]{40}$/.test(payTo ?? '')) {
  console.error('Usage: npx bun@1.3.14 run scripts/arkiv-ruled.ts <payTo>')
  process.exit(1)
}

const accessKey = process.env.ARKIV_ACCESS_KEY ?? ''
const rpcUrl = accessKey ? `${ARKIV_RPC}/${accessKey}` : ARKIV_RPC

interface Row {
  owner?: string
  createdAt?: string
  attributes?: { name: string; value: string | number | null }[]
}

/** The public nodes answer 429 when called too fast. A refused call waits as long as the node asks, up to 30 s, and tries again, up to 5 times. */
const patient: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init)
    const after = Number(res.headers.get('retry-after'))
    // A wait of minutes means the budget is spent, so the answer goes back to the caller at once.
    if (res.status !== 429 || attempt === 4 || after > 30) return res
    await new Promise((done) => setTimeout(done, after > 0 ? after * 1000 : 1500 * 2 ** attempt))
  }
}

async function arkiv<T>(method: string, params: unknown[]): Promise<T> {
  const res = await patient(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: T; error?: { message?: string } }
  if (!res.ok || body.result === undefined) throw new Error(`Arkiv refused ${method}: ${body.error?.message ?? res.status}`)
  return body.result
}

try {
  const ruled = await isRuledAgainst(payTo, { writers: 'any', verifyOnArc: true, rpcUrl, fetch: patient })
  console.log(`${new Date().toISOString()} isRuledAgainst('${payTo}', { writers: 'any', verifyOnArc: true }) -> ${ruled}`)

  // The claim behind the answer: the same query `isRuledAgainst` sends and the same 7 day window, newest
  // ruling first, stopping at the first one Arc confirms.
  const timing = await arkiv<{ current_block: number; current_block_time: number; duration: number }>('arkiv_getBlockTiming', [])
  const { data = [] } = await arkiv<{ data?: Row[] }>('arkiv_query', [
    rulingQuery(payTo, 'any'),
    { select: { owner: true, createdAt: true, attributes: true }, limit: '0x64' },
  ])
  const newestFirst = data.filter((row) => row.createdAt).sort((a, b) => Number(BigInt(b.createdAt!) - BigInt(a.createdAt!)))
  let shown = false
  for (const row of ruled ? newestFirst : []) {
    const age = (timing.current_block - Number(BigInt(row.createdAt!))) * timing.duration
    if (age >= RULING_SECONDS) break
    const value = (name: string) => {
      const found = row.attributes?.find((a) => a.name === name)?.value
      return found === undefined || found === null ? '' : String(found)
    }
    const against = value('pay_to') || value('seller')
    if (against.toLowerCase() !== payTo.toLowerCase()) continue
    const ruling = {
      claimId: value('claim_id'),
      claimTx: value('claim_tx'),
      contract: value('contract'),
      chainId: value('chain_id') || null,
      verdict: value('verdict'),
      writtenAt: timing.current_block_time - age,
    }
    if (!(await rulingOnArc(payTo, ruling, { fetch: patient }))) continue
    const at = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 16)}Z`
    console.log(`Newest ruling Arc confirms: ${ruling.verdict}, claim ${ruling.claimId}, written about ${at(ruling.writtenAt)} by ${row.owner ?? 'unknown'}`)
    console.log(`Claim on Arc: https://explorer.testnet.arc.io/tx/${ruling.claimTx}. vet402 does not pay this address until about ${at(ruling.writtenAt + RULING_SECONDS)}.`)
    shown = true
    break
  }
  if (!shown && !ruled) console.log('No ruling against this address in the last 7 days that Arc confirms.')
  if (!shown && ruled) console.log('The ruling Arc confirms is past the first 100 rows this script lists. The answer above stands.')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${accessKey ? message.split(accessKey).join('***') : message}. When that is 429 or ANON_COST_LIMITED, the public endpoints limit each caller, so try again later or set ARKIV_ACCESS_KEY.`)
  process.exit(2)
}
