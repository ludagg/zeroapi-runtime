import type { FilterMap, SortSpec, PaginationSpec, ParsedQuery } from './builder.js'
import type { ResourceDefinition, FeaturesConfig } from '../types/spec.js'

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
  if (cond.notin      !== undefined && cond.notin.includes(String(value))) return false

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

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Filters items by a full-text query `q` against the resource's `searchable`
 * fields. Case-insensitive substring match (OR across all searchable fields).
 *
 * Skipped when:
 *  - `q` is empty/undefined
 *  - `features.search.enabled` is not true
 *  - the resource declares no `searchable` fields
 */
export function applySearch(
  items: Row[],
  q: string | undefined,
  resource: ResourceDefinition,
  features?: FeaturesConfig,
): Row[] {
  if (!q || q.length === 0) return items
  if (features?.search?.enabled !== true) return items
  const searchable = resource.searchable ?? []
  if (searchable.length === 0) return items

  const needle = q.toLowerCase()
  return items.filter((item) =>
    searchable.some((field) => {
      const v = item[field]
      if (v === undefined || v === null) return false
      return String(v).toLowerCase().includes(needle)
    })
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

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface QueryResult {
  data: Row[]
  count: number
  nextCursor: string | null
  pagination: PaginationMeta
}

export interface ApplyQueryOptions {
  /** Required for ?q= search. Without a resource the search step is skipped. */
  resource?: ResourceDefinition
  /** Drives features-gated behaviour (search). */
  features?: FeaturesConfig
}

/**
 * Applies all query clauses (filter → search → sort → paginate) to an in-memory
 * array. `count` reflects the total matching records before pagination.
 *
 * Pagination mode resolution:
 *   - if `query.pagination.cursor` is set → cursor mode (returns nextCursor)
 *   - else if `query.pagination.page` is set → offset mode
 *   - else → cursor mode with no cursor (first page); backward compatible
 *
 * The `pagination` meta block is always populated so consumers can read totals
 * regardless of mode.
 */
export function applyQuery(
  items: Row[],
  query: ParsedQuery,
  options: ApplyQueryOptions = {},
): QueryResult {
  const filtered = applyFilters(items, query.filters)
  const searched = options.resource
    ? applySearch(filtered, query.q, options.resource, options.features)
    : filtered
  const sorted = applySorts(searched, query.sorts)

  const total = sorted.length
  const limit = query.pagination.limit

  let data: Row[]
  let nextCursor: string | null
  let page: number

  if (query.pagination.cursor !== undefined) {
    // Cursor mode — page count is not really meaningful, but report a 1-indexed
    // approximation based on the slice position so callers always get a number.
    const result = applyPagination(sorted, query.pagination)
    data = result.data
    nextCursor = result.nextCursor
    const idx = sorted.findIndex((item) => item['id'] === query.pagination.cursor)
    const startIndex = idx >= 0 ? idx + 1 : 0
    page = limit > 0 ? Math.floor(startIndex / limit) + 1 : 1
  } else if (query.pagination.page !== undefined) {
    // Offset mode — explicit page number.
    page = Math.max(1, query.pagination.page)
    const start = (page - 1) * limit
    data = sorted.slice(start, start + limit)
    nextCursor = null
  } else {
    // No cursor, no page — keep legacy first-page behaviour with cursor-style
    // nextCursor so existing clients are unaffected.
    const result = applyPagination(sorted, query.pagination)
    data = result.data
    nextCursor = result.nextCursor
    page = 1
  }

  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0
  const pagination: PaginationMeta = {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  }

  return { data, count: total, nextCursor, pagination }
}
