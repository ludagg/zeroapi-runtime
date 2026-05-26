import type { FilterMap, SortSpec, PaginationSpec, ParsedQuery } from './builder.js'

type Row = Record<string, unknown>

// ── Filtering ─────────────────────────────────────────────────────────────────

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

function matchesCondition(value: unknown, cond: FilterMap[string]): boolean {
  if (cond.eq         !== undefined && value !== cond.eq)         return false
  if (cond.ne         !== undefined && value === cond.ne)         return false
  if (cond.in         !== undefined && !cond.in.includes(String(value))) return false

  if (cond.contains   !== undefined &&
    !String(value).toLowerCase().includes(String(cond.contains).toLowerCase())) return false
  if (cond.startsWith !== undefined &&
    !String(value).toLowerCase().startsWith(String(cond.startsWith).toLowerCase())) return false
  if (cond.endsWith   !== undefined &&
    !String(value).toLowerCase().endsWith(String(cond.endsWith).toLowerCase())) return false

  if (cond.gt  !== undefined && compare(value, cond.gt)  <= 0) return false
  if (cond.gte !== undefined && compare(value, cond.gte) <  0) return false
  if (cond.lt  !== undefined && compare(value, cond.lt)  >= 0) return false
  if (cond.lte !== undefined && compare(value, cond.lte) >  0) return false

  return true
}

export function applyFilters(items: Row[], filters: FilterMap): Row[] {
  if (Object.keys(filters).length === 0) return items
  return items.filter((item) =>
    Object.entries(filters).every(([field, cond]) => matchesCondition(item[field], cond))
  )
}

// ── Sorting ───────────────────────────────────────────────────────────────────

export function applySorts(items: Row[], sorts: SortSpec[]): Row[] {
  if (sorts.length === 0) return items
  // Always append id:asc as a final tiebreak so the sort order is fully deterministic.
  // Without it, items with equal sort-key values can appear in different positions across
  // requests, causing cursor-based pagination to skip or duplicate records at page boundaries.
  const hasIdSort = sorts.some((s) => s.field === 'id')
  const effective: SortSpec[] = hasIdSort ? sorts : [...sorts, { field: 'id', direction: 'asc' }]
  return [...items].sort((a, b) => {
    for (const { field, direction } of effective) {
      const diff = compare(a[field], b[field])
      if (diff !== 0) return direction === 'asc' ? diff : -diff
    }
    return 0
  })
}

// ── Cursor pagination ─────────────────────────────────────────────────────────

export function applyPagination(
  items: Row[],
  pagination: PaginationSpec
): { data: Row[]; nextCursor: string | null } {
  const { cursor, limit } = pagination
  let startIndex = 0

  if (cursor) {
    const idx = items.findIndex((item) => item['id'] === cursor)
    startIndex = idx >= 0 ? idx + 1 : 0
  }

  const page = items.slice(startIndex, startIndex + limit)
  const lastItem = page[page.length - 1]
  const hasMore = startIndex + limit < items.length
  const nextCursor = hasMore && lastItem ? (lastItem['id'] as string) : null

  return { data: page, nextCursor }
}

// ── Combined ──────────────────────────────────────────────────────────────────

export interface QueryResult {
  data: Row[]
  count: number
  nextCursor: string | null
}

/**
 * Applies all query clauses (filter → sort → paginate) to an in-memory array.
 * `count` reflects the total matching records before pagination.
 */
export function applyQuery(items: Row[], query: ParsedQuery): QueryResult {
  const filtered = applyFilters(items, query.filters)
  const sorted   = applySorts(filtered, query.sorts)
  const { data, nextCursor } = applyPagination(sorted, query.pagination)
  return { data, count: filtered.length, nextCursor }
}
