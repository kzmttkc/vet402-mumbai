// The browser's side of "Try a dispute yourself". The function streams one JSON line per event.
// Nothing here sends an amount or a payee: the request has no body.

export const TRY_URL = '/api/try-dispute'
export const EXPLORER_TX = 'https://explorer.testnet.arc.io/tx/'
/** The public Swarm gateway, where anyone opens the claimed box by its reference. */
export const SWARM_BYTES = 'https://api.gateway.ethswarm.org/bytes/'
/** Arkiv's explorer for Rabdi, the network the README names. */
export const ARKIV_ENTITY = 'https://rabdi.explorer.arkiv.network/entity/'

export interface TryStep {
  label: string
  /** Milliseconds since the try started. */
  atMs: number
  /** The step's name as the server sends it, such as 'delivered'. */
  name?: string
  /** Where the line points, for the lines of the public record. */
  href?: string
}

export interface TryBox {
  contract: string
  ciphertext: string
  claimId: string
  plaintextHash: string
  keyBlock: string
}

export type TryResult =
  | { ok: true; lines: string[]; claimTx: string | null; answerTx: string | null; box: TryBox; totalMs: number }
  | { ok: false; message: string; claimTx: string | null; totalMs: number }

/** What the server sends once the try is on the public record, after the result. */
export type TryRecordLine =
  | { what: 'swarm'; ref: string; atMs: number }
  | { what: 'arkiv'; entityKey: string; entities: number | null; atMs: number }

type Line = ({ type: 'step' } & TryStep) | ({ type: 'result' } & TryResult) | ({ type: 'record' } & TryRecordLine)

/** The progress line for one record line, with its link. Null for anything that does not read as one. */
export function recordStep(line: TryRecordLine): TryStep | null {
  const atMs = typeof line.atMs === 'number' && Number.isFinite(line.atMs) ? line.atMs : 0
  if (line.what === 'swarm' && typeof line.ref === 'string' && /^[0-9a-f]{64}$/i.test(line.ref)) {
    return { label: 'Box on Swarm', atMs, name: 'swarm', href: `${SWARM_BYTES}${line.ref.toLowerCase()}` }
  }
  if (line.what === 'arkiv' && typeof line.entityKey === 'string' && /^0x[0-9a-f]{64}$/i.test(line.entityKey)) {
    const counted = typeof line.entities === 'number' && Number.isInteger(line.entities) && line.entities > 1
    const label = counted ? `Recorded on Arkiv: 1 transaction, ${line.entities} entities` : 'Recorded on Arkiv'
    return { label, atMs, name: 'arkiv', href: `${ARKIV_ENTITY}${line.entityKey.toLowerCase()}` }
  }
  return null
}

const COULD_NOT_START = 'The demo could not start just now. Please try again in a minute.'

/**
 * Starts a try and calls back for each step. `onResult` fires as soon as the result line arrives. The stream stays
 * open after it while the server keeps the try on the public record, and `onRecord` fires for each line of that
 * record, the box on Swarm and the entities on Arkiv. The promise resolves only when the stream ends, with the
 * result, or a failed one with the sentence to show.
 */
export async function startTry(
  onStep: (step: TryStep) => void,
  fetchImpl: typeof fetch = fetch,
  onResult?: (result: TryResult) => void,
  onRecord?: (step: TryStep) => void,
): Promise<TryResult> {
  let res: Response
  try {
    res = await fetchImpl(TRY_URL, { method: 'POST' })
  } catch {
    return { ok: false, message: COULD_NOT_START, claimTx: null, totalMs: 0 }
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    return { ok: false, message: typeof body?.error === 'string' ? body.error : COULD_NOT_START, claimTx: null, totalMs: 0 }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: TryResult | null = null
  const take = (text: string) => {
    if (!text.trim()) return
    let line: Line
    try {
      line = JSON.parse(text) as Line
    } catch {
      return
    }
    if (line.type === 'step') onStep({ label: line.label, atMs: line.atMs, ...(line.name ? { name: line.name } : {}) })
    else if (line.type === 'result') {
      const { type: _type, ...rest } = line
      result = rest
      onResult?.(result)
    } else if (line.type === 'record') {
      const step = recordStep(line)
      if (step) onRecord?.(step)
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        take(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
      }
    }
    take(buffer)
  } catch {
    // The line closed early. What arrived is still shown.
  }
  return result ?? { ok: false, message: COULD_NOT_START, claimTx: null, totalMs: 0 }
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
