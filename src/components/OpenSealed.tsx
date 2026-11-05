import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import type { Hex } from 'viem'
import { createEvidenceReader } from '@/arkiv/readArkiv'
import { COULD_NOT_READ_KEY, openFromRecord } from '@/lib/openSealed'
import type { EvidenceSources, OpenResult, PublicSealedFile } from '@/lib/openSealed'
import { loadSealedFile } from '@/lib/publicData'
import { createSwarmWire } from '@/lib/swarmBox'

const button =
  'flex min-h-11 items-center gap-2 rounded-full border border-[var(--border)] bg-white px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:opacity-40'

/** Arkiv and Swarm straight from the browser. With no writer in the build, the exported file is used. */
function publicSources(): EvidenceSources {
  if (!__ARKIV_WRITER__) return {}
  const swarm = createSwarmWire()
  return { readEvidence: createEvidenceReader(__ARKIV_WRITER__ as Hex), downloadBox: (reference) => swarm.download(reference) }
}

/** Opens a sealed answer in the browser, with the key read straight from the chain. Nothing here can pay. */
export function OpenSealed() {
  const sources = useMemo(() => publicSources(), [])
  const [file, setFile] = useState<PublicSealedFile>({ contract: null, answers: [] })
  const [results, setResults] = useState<Record<string, OpenResult>>({})
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    void loadSealedFile().then(setFile)
  }, [])

  const open = async (ref: string) => {
    const answer = file.answers.find((a) => a.ref === ref)
    if (!answer) return
    setOpening(ref)
    const result: OpenResult = file.contract
      ? await openFromRecord(answer, file.contract, sources)
      : { ok: false, line: COULD_NOT_READ_KEY }
    setResults((current) => ({ ...current, [ref]: result }))
    setOpening(null)
  }

  return (
    <div className="mt-4 rounded-2xl bg-[var(--surface-muted)] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
          <KeyRound size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">Open a sealed answer</p>
          <p className="text-sm text-pretty text-[var(--muted)]">The key is public. Your browser opens the answer by itself.</p>
        </div>
      </div>

      {file.answers.length === 0 && <p className="mt-3 text-sm text-[var(--muted)]">No sealed answers yet.</p>}

      <ul className="mt-3 space-y-3">
        {file.answers.map((answer) => {
          const result = results[answer.ref]
          return (
            <li key={answer.ref} className="rounded-xl bg-white p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{answer.sellerName}</span>
                <button type="button" disabled={opening !== null} onClick={() => void open(answer.ref)} className={button}>
                  {opening === answer.ref && <Loader2 size={14} className="animate-spin" aria-hidden />}
                  Open
                </button>
              </div>
              {result?.read?.map((line) => (
                <p key={line} className="mt-2 text-sm text-[var(--muted)]">
                  {line}
                </p>
              ))}
              {result?.ok && <p className="mt-2 break-words text-sm">{result.text}</p>}
              {result && (
                <p className={`mt-2 text-sm font-semibold ${result.ok && result.matches ? '' : 'text-[var(--danger)]'}`} role="status">
                  {result.line}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
