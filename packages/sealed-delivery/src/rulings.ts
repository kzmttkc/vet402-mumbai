// Any x402 buyer can read vet402's rulings before it pays: one Arkiv query by the seller's payTo address.
// The query and the 7 day window are the ones vet402's own delivery check uses (server/arkiv.ts).
// It is plain JSON-RPC over fetch, with no key, no wallet and no extra dependency.

/** Arkiv's testnet, where vet402 writes its `vet402_verdict` entities. The public endpoint needs no key. */
export const ARKIV_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network'
/** A ruling stops payment to that address for this long, counted from the Arkiv block it was written in. */
export const RULING_SECONDS = 604_800
/** Arc's testnet, where the SealedDelivery contract rules. The public endpoint needs no key. */
export const ARC_TESTNET_RPC = 'https://rpc.testnet.arc.network'
/** vet402's SealedDelivery deployments on Arc testnet: the current one and the version before it. */
export const SEALED_DELIVERY_ARC_TESTNET = ['0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B', '0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5']
/** topic0 of `Silent(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)`. */
export const SILENT_TOPIC = '0xc5aa6a021d29c353e570edaf6cf7a316167639021132ced196609cf63baf7411'
/** topic0 of `Fraud(bytes32 indexed claimId, bytes32 indexed paymentNonce, address indexed seller, address buyer, uint256 paidOut)`. */
export const FRAUD_TOPIC = '0xd701d68c0783ed08a7c6c128cbe19074948f794dd05363075f21ea67cdb48a88'
const PAGE = 100
const MAX_PAGES = 20
/** Arc's node refuses an eth_getLogs range much wider than this. */
const LOG_STEP = 10_000n
const MAX_LOG_READS = 50
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/

interface RulingRead {
  /** Another Arkiv endpoint, such as one with your own access key in its path. */
  rpcUrl?: string
  /** How far back a ruling counts. Defaults to 7 days. */
  withinSeconds?: number
  /**
   * Counts a ruling only when Arc holds the contract's own Silent or Fraud event for its claim, against
   * this payTo address. The writer can then only repeat what the contract decided.
   */
  verifyOnArc?: boolean
  /** The Arc node read when `verifyOnArc` is on. Defaults to Arc testnet. */
  arcRpcUrl?: string
  /** The SealedDelivery deployments whose events count. Defaults to vet402's on Arc testnet. */
  contracts?: string[]
  fetch?: typeof fetch
}

export type RulingOptions = RulingRead &
  (
    | {
        /** The writer whose rulings you trust, for example vet402's `0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5`. Only its entities count. */
        writer: string
        writers?: undefined
      }
    | {
        /** Rulings from every writer count, vet402 among them. Each counts only once Arc confirms it, so `verifyOnArc` has to be on. */
        writers: 'any'
        writer?: undefined
      }
  )

/** What a `vet402_verdict` entity says about one claim, as `rulingOnArc` needs it. */
export interface ArcRuling {
  claimId: string
  claimTx?: string | null
  contract?: string | null
  chainId?: bigint | number | string | null
  verdict: string
  /** Unix seconds the ruling reached Arkiv. The event has to be on Arc by then. */
  writtenAt: number
}

export interface ArcCheckOptions {
  rpcUrl?: string
  contracts?: string[]
  fetch?: typeof fetch
}

/**
 * The query string, so a buyer can run the same thing by hand with `arkiv_query`. It matches `pay_to` or
 * `seller`, as entities written before `pay_to` carry `seller` alone. `'any'` leaves out the writer filter.
 */
export function rulingQuery(payTo: string, writer: string): string {
  if (!ADDRESS.test(payTo) || (writer !== 'any' && !ADDRESS.test(writer))) throw new Error('payTo and writer must be 0x addresses')
  const address = payTo.toLowerCase()
  const owner = writer === 'any' ? '' : ` AND $owner = addr(${writer})`
  return `arkiv.schema = str('vet402_verdict') AND kind = str('verdict') AND (pay_to = str('${address}') OR seller = str('${address}'))${owner}`
}

async function call<T>(fetchImpl: typeof fetch, url: string, method: string, params: unknown[], node = 'Arkiv'): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`${node} answered ${res.status}`)
  const body = (await res.json()) as { result?: T; error?: { message?: string } }
  if (body.error || body.result === undefined) throw new Error(`${node} refused ${method}: ${body.error?.message ?? 'no result'}`)
  return body.result
}

const hex = (n: bigint) => `0x${n.toString(16)}`

/**
 * True when Arc holds the contract's Silent or Fraud event for this ruling's claim, against this payTo
 * address, after the claim's own transaction and no later than the ruling reached Arkiv. A ruling that
 * lacks its claim transaction, names another contract or chain, or whose event is not found is false.
 * A failed read throws.
 */
export async function rulingOnArc(payTo: string, ruling: ArcRuling, options: ArcCheckOptions = {}): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch
  const url = options.rpcUrl ?? ARC_TESTNET_RPC
  const arc = <T>(method: string, params: unknown[]) => call<T>(fetchImpl, url, method, params, 'Arc')
  const claimId = ruling.claimId.toLowerCase()
  const claimTx = ruling.claimTx ?? ''
  const contract = (ruling.contract ?? '').toLowerCase()
  const topic = ruling.verdict === 'silent' ? SILENT_TOPIC : ruling.verdict === 'fraud' ? FRAUD_TOPIC : null
  const accepted = (options.contracts ?? SEALED_DELIVERY_ARC_TESTNET).map((a) => a.toLowerCase())
  if (!ADDRESS.test(payTo) || !BYTES32.test(claimId) || !BYTES32.test(claimTx) || !ADDRESS.test(contract) || !topic) return false
  if (!accepted.includes(contract) || ruling.chainId === null || ruling.chainId === undefined) return false
  if (BigInt(await arc<string>('eth_chainId', [])) !== BigInt(ruling.chainId)) return false

  // The claim itself: mined, and carrying this claim id from this contract.
  const receipt = await arc<{ status?: string; blockNumber: string; logs?: { address: string; topics?: string[] }[] } | null>(
    'eth_getTransactionReceipt',
    [claimTx],
  )
  if (!receipt || receipt.status !== '0x1') return false
  if (!(receipt.logs ?? []).some((log) => log.address.toLowerCase() === contract && log.topics?.[1]?.toLowerCase() === claimId)) return false

  // finalize or prove emits the ruling in a later transaction, so the logs are read forward from the claim.
  const seller = `0x${payTo.slice(2).toLowerCase().padStart(64, '0')}`
  const latest = BigInt(await arc<string>('eth_blockNumber', []))
  let from = BigInt(receipt.blockNumber)
  for (let read = 0; read < MAX_LOG_READS && from <= latest; read++) {
    if (read > 0) {
      const block = await arc<{ timestamp: string } | null>('eth_getBlockByNumber', [hex(from), false])
      if (!block || Number(BigInt(block.timestamp)) > ruling.writtenAt) return false
    }
    const to = from + LOG_STEP - 1n < latest ? from + LOG_STEP - 1n : latest
    const logs = await arc<unknown[]>('eth_getLogs', [{ address: contract, fromBlock: hex(from), toBlock: hex(to), topics: [topic, claimId, null, seller] }])
    if (logs.length > 0) return true
    from = to + 1n
  }
  return false
}

interface RulingRow {
  createdAt?: string
  attributes?: { name: string; value: unknown }[]
}

/**
 * True when the writer recorded a Silent or Fraud ruling from the SealedDelivery contract against this
 * payTo address within the window. With `verifyOnArc`, only a ruling whose event Arc holds counts.
 * With `writers: 'any'`, a ruling from any writer counts once Arc confirms it, and without `verifyOnArc`
 * it throws. A row is judged by its `pay_to` when it has one. A failed read throws, so the caller decides whether to pay without it. vet402 itself does not pay
 * when the read fails.
 */
export async function isRuledAgainst(payTo: string, options: RulingOptions): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch
  const url = options.rpcUrl ?? ARKIV_RPC
  const anyWriter = options.writers === 'any'
  if (anyWriter && !options.verifyOnArc) throw new Error("writers: 'any' counts only rulings Arc confirms, so it needs verifyOnArc: true")
  // `writer` is always one address, so `writer: 'any'` cannot drop the filter without verifyOnArc.
  if (!anyWriter && !ADDRESS.test(options.writer ?? '')) throw new Error('payTo and writer must be 0x addresses')
  const query = rulingQuery(payTo, anyWriter ? 'any' : options.writer!)
  const timing = await call<{ current_block: number; current_block_time: number; duration: number }>(fetchImpl, url, 'arkiv_getBlockTiming', [])
  const within = BigInt(options.withinSeconds ?? RULING_SECONDS)
  const select = { key: true, createdAt: true, attributes: true }
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call<{ data?: RulingRow[] }>(fetchImpl, url, 'arkiv_query', [
      query,
      { select, limit: `0x${PAGE.toString(16)}`, offset: `0x${(page * PAGE).toString(16)}` },
    ])
    const rows = result.data ?? []
    for (const row of rows) {
      if (!row.createdAt) continue
      const age = (BigInt(timing.current_block) - BigInt(row.createdAt)) * BigInt(timing.duration)
      if (age >= within) continue
      const value = (name: string) => {
        const found = row.attributes?.find((a) => a.name === name)?.value
        return found === undefined || found === null ? null : String(found)
      }
      // Either column matched the query. When `pay_to` is there it decides, as on the receipts page.
      const against = value('pay_to') ?? value('seller')
      if (against !== null && against.toLowerCase() !== payTo.toLowerCase()) continue
      if (!options.verifyOnArc) return true
      const ruling: ArcRuling = {
        claimId: value('claim_id') ?? '',
        claimTx: value('claim_tx'),
        contract: value('contract'),
        chainId: value('chain_id'),
        verdict: value('verdict') ?? '',
        writtenAt: timing.current_block_time - Number(age),
      }
      const arcOptions = { fetch: fetchImpl, ...(options.arcRpcUrl ? { rpcUrl: options.arcRpcUrl } : {}), ...(options.contracts ? { contracts: options.contracts } : {}) }
      if (await rulingOnArc(payTo, ruling, arcOptions)) return true
    }
    if (rows.length < PAGE) return false
  }
  throw new Error(`More than ${MAX_PAGES * PAGE} rulings. Not all were read.`)
}
