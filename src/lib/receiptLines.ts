// A receipt reads in plain words first. The line that names the mechanism (the gas, the claim, the contract)
// is kept in the same list with a mark, so a judge can still check it, and the screens show it only under Details.

export const DETAIL_PREFIX = 'Detail: '

/** Marks a line as technical: the screens put it under Details. */
export const detail = (text: string) => `${DETAIL_PREFIX}${text}`

/** The plain lines for the body, and the technical ones, without their mark, for Details. */
export function splitLines(lines: readonly string[]): { plain: string[]; details: string[] } {
  const plain: string[] = []
  const details: string[] = []
  for (const line of lines) {
    if (line.startsWith(DETAIL_PREFIX)) details.push(line.slice(DETAIL_PREFIX.length))
    else plain.push(line)
  }
  return { plain, details }
}
