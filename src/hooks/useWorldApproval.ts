import { useCallback, useEffect, useRef, useState } from 'react'

export interface WorldRequestView {
  id: string
  kind: 'budget' | 'hold'
  state: 'waiting' | 'creating' | 'done' | 'closed'
  message: string
}

interface WorldStatus {
  enabled: boolean
  budgetSet?: boolean
  hasLastApproval?: boolean
  request?: WorldRequestView | null
}

interface IdkitParams {
  app_id: `app_${string}`
  environment: 'staging'
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string }
  session_id?: `session_${string}`
  signal?: string
}

interface Started {
  request: WorldRequestView
  idkit: IdkitParams
}

const POLL_MS = 1000
const STATUS_RETRY_MS = 3000
const NOT_APPROVED = 'Not approved. Nothing was held or paid.'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function send<T>(route: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`/api/world/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !parsed) throw new Error(parsed?.error ?? NOT_APPROVED)
  return parsed
}

// Loaded only when a request starts, so the plain hold never pulls IDKit in.
async function openIdkitRequest(idkit: IdkitParams) {
  const { IDKit, CredentialRequest } = await import('@worldcoin/idkit-core')
  const config = { app_id: idkit.app_id, rp_context: idkit.rp_context, environment: idkit.environment }
  return idkit.session_id
    ? IDKit.proveSession(idkit.session_id, config).constraints(
        CredentialRequest('proof_of_human', { signal: idkit.signal }),
      )
    : IDKit.createSession(config).constraints(CredentialRequest('proof_of_human'))
}

/** Passes IDKit's result to the backend and shows what the backend returns. The browser never decides. */
export function useWorldApproval(onDone: () => Promise<void>) {
  const [status, setStatus] = useState<WorldStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canCopy, setCanCopy] = useState(false)
  const connectorURI = useRef<string | null>(null)
  // Only the newest loop may go on polling.
  const loop = useRef(0)

  const load = useCallback(async () => {
    const res = await fetch('/api/world/status')
    if (!res.ok) throw new Error('request failed')
    const next = (await res.json()) as WorldStatus
    setStatus(next)
    return next
  }, [])

  const finish = useCallback(async () => {
    loop.current += 1
    connectorURI.current = null
    setCanCopy(false)
    await load().catch(() => {})
    await onDone()
  }, [load, onDone])

  type IdkitRequest = Awaited<ReturnType<typeof openIdkitRequest>>

  const poll = useCallback(
    async (id: string, request: IdkitRequest | null) => {
      const mine = ++loop.current
      let proof: unknown = null
      let told = false

      while (loop.current === mine) {
        try {
          // A proof is only handed out once, so it stays here until the backend has taken it.
          if (request && proof === null && !told) {
            const seen = await request.pollOnce()
            if (seen.type === 'confirmed' && seen.result) proof = seen.result
            if (seen.type === 'failed') told = true
          }
          if (proof !== null) {
            // Making the hold takes a while. Keep reading the backend so the screen moves on from waiting.
            const reading = setInterval(() => void load().catch(() => {}), POLL_MS)
            try {
              await send(`requests/${id}/complete`, { result: proof })
            } finally {
              clearInterval(reading)
            }
          } else if (told) {
            await send(`requests/${id}/cancel`)
          }

          const latest = await load()
          if (latest.request?.id !== id || latest.request.state !== 'waiting') break
        } catch {
          // The backend closes the request after 2 minutes, so a network blip cannot leave this running.
        }
        await sleep(POLL_MS)
      }
      if (loop.current === mine) await finish()
    },
    [finish, load],
  )

  useEffect(() => {
    const stop = new AbortController()
    const first = async () => {
      while (!stop.signal.aborted) {
        try {
          const next = await load()
          // A reload loses the IDKit request. The backend still closes it, and Cancel request still works.
          if (next.request?.state === 'waiting') void poll(next.request.id, null)
          return
        } catch {
          await sleep(STATUS_RETRY_MS)
        }
      }
    }
    void first()
    return () => {
      stop.abort()
      loop.current += 1
    }
  }, [load, poll])

  const begin = useCallback(
    async (route: 'budget' | 'hold', amount: string) => {
      setError(null)
      let started: Started
      try {
        started = await send<Started>(route, { amount })
      } catch (e) {
        setError(e instanceof Error ? e.message : NOT_APPROVED)
        return
      }
      setStatus((old) => ({ ...old, enabled: true, request: started.request }))
      try {
        const request = await openIdkitRequest(started.idkit)
        connectorURI.current = request.connectorURI
        setCanCopy(true)
        void poll(started.request.id, request)
      } catch {
        // IDKit could not open the request, so it can never be approved. The backend says how it ended.
        await send(`requests/${started.request.id}/cancel`).catch(() => {})
        await finish()
      }
    },
    [finish, poll],
  )

  const copy = useCallback(async () => {
    if (connectorURI.current) await navigator.clipboard.writeText(connectorURI.current)
  }, [])

  const endWith = useCallback(
    async (action: 'cancel' | 'use-last-approval') => {
      const id = status?.request?.id
      if (!id) return
      try {
        await send(`requests/${id}/${action}`)
      } catch {
        // The status read in finish() shows where the request really is.
      }
      const latest = await load().catch(() => null)
      if (latest?.request?.state !== 'waiting') await finish()
    },
    [finish, load, status?.request?.id],
  )

  return {
    loaded: status !== null,
    enabled: status?.enabled ?? false,
    budgetSet: status?.budgetSet ?? false,
    hasLastApproval: status?.hasLastApproval ?? false,
    request: status?.request ?? null,
    canCopy,
    error,
    setBudget: (amount: string) => begin('budget', amount),
    hold: (amount: string) => begin('hold', amount),
    copy,
    cancel: () => endWith('cancel'),
    useLastApproval: () => endWith('use-last-approval'),
  }
}

export type WorldApproval = ReturnType<typeof useWorldApproval>
