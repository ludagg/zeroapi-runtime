// ── Types ─────────────────────────────────────────────────────────────────────

export interface FilterCondition {
  contains?: string
  eq?: string | number | boolean
  ne?: string | number | boolean
  gt?: number | string
  gte?: number | string
  lt?: number | string
  lte?: number | string
  in?: string[]
  notin?: string[]
  startsWith?: string
  endsWith?: string
}

export type FilterMap = Record<string, FilterCondition>

export interface SortSpec {
  field: string
  direction: 'asc' | 'desc'
}

export interface PaginationSpec {
  /** Cursor-based pagination (existing behaviour). */
  cursor?: string
  /** Offset-based page number (1-indexed). Only used when `cursor` is absent. */
  page?: number
  /** Page size, capped by `maxLimit`. */
  limit: number
}

export interface ParsedQuery {
  filters: FilterMap
  sorts: SortSpec[]
  pagination: PaginationSpec
  include: string[]
  /** Full-text search term (?q=). Resolved against `resource.searchable` fields. */
  q?: string
  /** Operators present in the URL that the parser does not recognise.
   *  The route layer turns these into a 400 "Unknown operator". */
  unknownOperators: Array<{ field: string; operator: string }>
}

export interface ParseQueryOptions {
  /** Default limit when ?limit= is missing. Falls back to 20. */
  defaultLimit?: number
  /** Hard cap on ?limit=. Falls back to 100. */
  maxLimit?: number
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const BRACKET_RE = /^([^[]+)\[([^\]]+)\]$/  // field[operator]
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** Params consumed by the parser itself (not turned into filters). */
const RESERVED_PARAMS = new Set(['sort', 'cursor', 'limit', 'include', 'q', 'page'])

const ALLOWED_OPERATORS = new Set([
  'contains', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notin',
  // Kept for backward compatibility — predate Phase 2.2.
  'startsWith', 'endsWith',
])

function coerceValue(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  return Number.isFinite(n) ? n : raw
}

function parseSortPart(raw: string): SortSpec | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // "-field" → descending. Also accept "-field:dir" defensively (the `-`
  // takes precedence so the explicit dir is ignored).
  if (trimmed.startsWith('-')) {
    let field = trimmed.slice(1)
    const colon = field.indexOf(':')
    if (colon >= 0) field = field.slice(0, colon)
    if (!field) return null
    return { field, direction: 'desc' }
  }

  // "field:asc" / "field:desc"
  if (trimmed.includes(':')) {
    const [field, dir] = trimmed.split(':')
    if (!field) return null
    return { field, direction: dir === 'desc' ? 'desc' : 'asc' }
  }

  // Bare field → ascending.
  return { field: trimmed, direction: 'asc' }
}

/**
 * Parses URL search params into a structured query object.
 *
 * Supported patterns:
 *   ?field=val              — equality (shortcut for ?field[eq]=val)
 *   ?field[eq]=val          — equality
 *   ?field[ne]=val          — inequality
 *   ?field[contains]=val    — substring (case-insensitive)
 *   ?field[gt|gte|lt|lte]=val  — numeric/date comparison
 *   ?field[in]=a,b,c        — set membership
 *   ?field[notin]=a,b,c     — set non-membership
 *   ?sort=field:asc,field2:desc  — legacy multi-sort
 *   ?sort=-price,title      — Phase 2.2 syntax; `-` prefix = desc
 *   ?cursor=cuid&limit=20   — cursor pagination
 *   ?page=2&limit=20        — offset pagination
 *   ?q=phone                — full-text search across resource.searchable
 *   ?include=resource1,res2 — relation hydration
 *
 * The second argument exposes feature-driven defaults (features.pagination)
 * so callers can override the built-in 20/100 defaults.
 */
export function parseQueryParams(
  urlOrParams: string | URL | URLSearchParams,
  options: ParseQueryOptions = {},
): ParsedQuery {
  let params: URLSearchParams
  if (urlOrParams instanceof URLSearchParams) {
    params = urlOrParams
  } else {
    params = new URL(typeof urlOrParams === 'string' ? urlOrParams : urlOrParams.toString()).searchParams
  }

  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT
  const maxLimit = options.maxLimit ?? MAX_LIMIT

  const filters: FilterMap = {}
  const sorts: SortSpec[] = []
  const unknownOperators: Array<{ field: string; operator: string }> = []
  let cursor: string | undefined
  let page: number | undefined
  let limit = defaultLimit
  let include: string[] = []
  let q: string | undefined

  for (const [key, value] of params.entries()) {
    if (key === 'sort') {
      for (const part of value.split(',')) {
        const spec = parseSortPart(part)
        if (spec) sorts.push(spec)
      }
      continue
    }
    if (key === 'cursor') { cursor = value; continue }
    if (key === 'page') {
      const n = parseInt(value, 10)
      if (Number.isFinite(n) && n >= 1) page = n
      continue
    }
    if (key === 'limit') {
      const n = parseInt(value, 10)
      limit = Number.isFinite(n) ? Math.min(Math.max(1, n), maxLimit) : defaultLimit
      continue
    }
    if (key === 'include') {
      include = value.split(',').map((s) => s.trim()).filter(Boolean)
      continue
    }
    if (key === 'q') { q = value; continue }

    const bracket = BRACKET_RE.exec(key)
    if (bracket) {
      const [, field, op] = bracket
      if (!field || !op) continue

      if (!ALLOWED_OPERATORS.has(op)) {
        unknownOperators.push({ field, operator: op })
        continue
      }

      if (!filters[field]) filters[field] = {}
      const cond = filters[field]

      switch (op) {
        case 'contains':    cond.contains    = value; break
        case 'eq':          cond.eq          = coerceValue(value); break
        case 'ne':          cond.ne          = coerceValue(value); break
        case 'gt':          cond.gt          = coerceValue(value) as number | string; break
        case 'gte':         cond.gte         = coerceValue(value) as number | string; break
        case 'lt':          cond.lt          = coerceValue(value) as number | string; break
        case 'lte':         cond.lte         = coerceValue(value) as number | string; break
        case 'in':          cond.in          = value.split(',').map((s) => s.trim()); break
        case 'notin':       cond.notin       = value.split(',').map((s) => s.trim()); break
        case 'startsWith':  cond.startsWith  = value; break
        case 'endsWith':    cond.endsWith    = value; break
      }
    } else {
      // Treat plain ?field=val as eq filter (skip internal params).
      if (!RESERVED_PARAMS.has(key)) {
        if (!filters[key]) filters[key] = {}
        filters[key].eq = coerceValue(value)
      }
    }
  }

  const pagination: PaginationSpec = { limit }
  if (cursor !== undefined) pagination.cursor = cursor
  if (page !== undefined) pagination.page = page

  const out: ParsedQuery = { filters, sorts, pagination, include, unknownOperators }
  if (q !== undefined) out.q = q
  return out
}

/** Converts a ParsedQuery into a Prisma-compatible where/orderBy/cursor/take object. */
export function toPrismaQuery(query: ParsedQuery): {
  where: Record<string, unknown>
  orderBy: Record<string, string>[]
  cursor: { id: string } | undefined
  take: number
  skip: number
} {
  const where: Record<string, unknown> = {}

  for (const [field, cond] of Object.entries(query.filters)) {
    const prismaField: Record<string, unknown> = {}
    if (cond.contains   !== undefined) prismaField['contains']   = cond.contains
    if (cond.eq         !== undefined) prismaField['equals']     = cond.eq
    if (cond.ne         !== undefined) prismaField['not']        = cond.ne
    if (cond.gt         !== undefined) prismaField['gt']         = cond.gt
    if (cond.gte        !== undefined) prismaField['gte']        = cond.gte
    if (cond.lt         !== undefined) prismaField['lt']         = cond.lt
    if (cond.lte        !== undefined) prismaField['lte']        = cond.lte
    if (cond.in         !== undefined) prismaField['in']         = cond.in
    if (cond.notin      !== undefined) prismaField['notIn']      = cond.notin
    if (cond.startsWith !== undefined) prismaField['startsWith'] = cond.startsWith
    if (cond.endsWith   !== undefined) prismaField['endsWith']   = cond.endsWith
    where[field] = prismaField
  }

  const orderBy = query.sorts.map(({ field, direction }) => ({ [field]: direction }))
  const cursor = query.pagination.cursor ? { id: query.pagination.cursor } : undefined
  const page = query.pagination.page ?? 1
  // In cursor mode Prisma ignores `skip` once `cursor` is set; in offset mode
  // we derive `skip` from the 1-indexed page so the caller gets the right slice.
  const skip = cursor ? 0 : Math.max(0, (page - 1) * query.pagination.limit)

  return { where, orderBy, cursor, take: query.pagination.limit, skip }
}
