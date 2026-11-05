// The browser's side of "Try a dispute yourself". The function streams one JSON line per event.
// Nothing here sends an amount or a payee: the request has no body.

export const TRY_URL = '/api/try-dispute'
export const EXPLORER_TX = 'https://explorer.testnet.arc.io/tx/'

export interface TryStep {
  label: string
  /** Milliseconds since the try started. */
  atMs: number
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

type Line = ({ type: 'step' } & TryStep) | ({ type: 'result' } & TryResult)

const COULD_NOT_START = 'The demo could not start just now. Please try again in a minute.'

/** Starts a try and calls back for each step. Resolves with the result, or a failed one with the sentence to show. */
export async function startTry(onStep: (step: TryStep) => void, fetchImpl: typeof fetch = fetch): Promise<TryResult> {
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
    if (line.type === 'step') onStep({ label: line.label, atMs: line.atMs })
    else if (line.type === 'result') {
      const { type: _type, ...rest } = line
      result = rest as TryResult
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
