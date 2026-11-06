/** The node's largest page. */
export const PAGE_SIZE = 100

/** 2,000 rows at most. A query that matches more stops with an error instead of dropping rows. */
export const MAX_PAGES = 20

export interface Page<T> {
  readonly entities: readonly T[]
  /** Matches the page left out for not fitting the schema. They count toward the offset. */
  readonly skipped: number
}

/**
 * Reads every match of one query, one page of 100 at a time. The caller sorts by `$key`, so the
 * pages line up. A row that a write between two pages moves onto the next page is read once,
 * because rows are kept by key.
 */
export async function readAllPages<T extends { $key: string }>(
  page: (offset: number) => Promise<Page<T>>,
  maxPages: number = MAX_PAGES,
): Promise<T[]> {
  const rows = new Map<string, T>()
  let offset = 0
  for (let read = 0; read < maxPages; read++) {
    const { entities, skipped } = await page(offset)
    for (const row of entities) rows.set(row.$key, row)
    const covered = entities.length + skipped
    if (covered < PAGE_SIZE) return [...rows.values()]
    offset += covered
  }
  throw new Error(`More than ${maxPages * PAGE_SIZE} matches. Not all were read.`)
}
