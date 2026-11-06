/**
 * A seller that answers in JSON usually puts the sentence for people in "message" or "answer".
 * Show that sentence, and the answer as it came otherwise.
 */
export function readable(text: string): string {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object') {
      const { message, answer } = value as { message?: unknown; answer?: unknown }
      if (typeof message === 'string') return message
      if (typeof answer === 'string') return answer
    }
  } catch {
    // Not JSON. The answer is shown as it came.
  }
  return text
}
