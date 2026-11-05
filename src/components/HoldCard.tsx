import { useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { parseUsdc } from '@/onchain-money'
import { useStartHold } from '@/hooks/useStartHold'
import type { Balances } from '@/hooks/useBalances'

const fmt = (value: string) =>
  Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function holdLine(hold: Balances['hold'] | undefined): string {
  if (!hold) return ''
  switch (hold.state) {
    case 'none':
      return 'No hold yet. The agent can’t spend anything.'
    case 'setting-up':
      return 'Setting up the hold…'
    case 'active':
      return `${fmt(hold.remaining)} USDC left on hold for this job.`
    case 'used-up':
      return 'The hold is used up. Nothing more was paid.'
  }
}

function validAmount(text: string, balance: string | undefined): string | null {
  try {
    const raw = parseUsdc(text)
    if (raw <= 0n) return null
    if (balance !== undefined && raw > parseUsdc(balance)) return null
    return text
  } catch {
    return null
  }
}

export function HoldCard({ data, reload }: { data: Balances | null; reload: () => Promise<void> }) {
  const [text, setText] = useState('1')
  const { start, pending, error } = useStartHold(reload)

  const amount = validAmount(text, data?.balance)
  const busy = pending || data?.hold.state === 'setting-up'
  const used = data?.hold.state === 'used-up'

  return (
    <div className="mt-6 rounded-2xl bg-[var(--surface-muted)] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)]">
          <Bot size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--muted)]">Agent hold</p>
          {data ? (
            <p className={`text-base font-semibold text-pretty ${used ? 'text-[var(--danger)]' : ''}`} aria-live="polite">
              {holdLine(data.hold)}
            </p>
          ) : (
            <div aria-hidden className="mt-1 h-5 w-40 animate-pulse rounded-md bg-white" />
          )}
        </div>
      </div>

      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (amount && !busy) void start(amount)
        }}
      >
        <label className="block">
          <span className="sr-only">Amount to hold in USDC</span>
          <div className="flex items-center rounded-xl border border-[var(--border)] bg-white px-4 focus-within:border-[var(--focus)]">
            <input
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
              className="display min-h-12 w-full bg-transparent text-2xl font-semibold tabular-nums outline-none"
            />
            <span className="text-sm font-medium text-[var(--muted)]">USDC</span>
          </div>
        </label>

        <button
          type="submit"
          disabled={!amount || busy}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ink)] px-5 text-base font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:opacity-40"
        >
          {busy && <Loader2 size={18} className="animate-spin" aria-hidden />}
          {busy ? 'Setting up the hold…' : `Hold ${amount ?? text} USDC for this job`}
        </button>

        {error && (
          <p className="text-sm text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  )
}
