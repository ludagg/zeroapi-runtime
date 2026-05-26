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
  startsWith?: string
  endsWith?: string
}

export type FilterMap = Record<string, FilterCondition>

export interface SortSpec {
  field: string
  direction: 'asc' | 'desc'
}

export interface PaginationSpec {
  cursor?: string
  limit: number
}

export interface ParsedQuery {
  filters: FilterMap
  sorts: SortSpec[]
  pagination: PaginationSpec
  include: string[]
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const BRACKET_RE = /^([^[]+)\[([^\]]+)\]$/  // field[operator]
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function coerceValue(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  return Number.isFinite(n) ? n : raw
}

/**
 * Parses URL search params into a structured query object.
 *
 * Supported patterns:
 *   ?field[contains]=val   — substring match
 *   ?field[eq]=val         — equality (also plain ?field=val)
 *   ?field[ne]=val         — inequality
 *   ?field[gt/gte/lt/lte]=val — numeric/date comparison
 *   ?field[in]=a,b,c       — set membership
 *   ?field[startsWith]=val — prefix match
 *   ?field[endsWith]=val   — suffix match
 *   ?sort=field:asc,field2:desc
 *   ?cursor=cuid&limit=20
 *   ?include=resource1,resource2
 */
export function parseQueryParams(urlOrParams: string | URL | URLSearchParams): ParsedQuery {
  let params: URLSearchParams
  if (urlOrParams instanceof URLSearchParams) {
    params = urlOrParams
  } else {
    params = new URL(typeof urlOrParams === 'string' ? urlOrParams : urlOrParams.toString()).searchParams
  }

  const filters: FilterMap = {}
  const sorts: SortSpec[] = []
  let cursor: string | undefined
  let limit = DEFAULT_LIMIT
  let include: string[] = []

  for (const [key, value] of params.entries()) {
    if (key === 'sort') {
      for (const part of value.split(',')) {
        const [field, dir] = part.trim().split(':')
        if (field) {
          sorts.push({ field, direction: dir === 'desc' ? 'desc' : 'asc' })
        }
      }
      continue
    }
    if (key === 'cursor') { cursor = value; continue }
    if (key === 'limit') {
      const n = parseInt(value, 10)
      limit = Number.isFinite(n) ? Math.min(Math.max(1, n), MAX_LIMIT) : DEFAULT_LIMIT
      continue
    }
    if (key === 'include') {
      include = value.split(',').map((s) => s.trim()).filter(Boolean)
      continue
    }

    const bracket = BRACKET_RE.exec(key)
    if (bracket) {
      const [, field, op] = bracket
      if (!field) continue
      if (!filters[field]) filters[field] = {}
      const cond = filters[field]!

      switch (op) {
        case 'contains':    cond.contains    = value; break
        case 'eq':         cond.eq          = coerceValue(value); break
        case 'ne':         cond.ne          = coerceValue(value); break
        case 'gt':         cond.gt          = coerceValue(value) as number | string; break
        case 'gte':        cond.gte         = coerceValue(value) as number | string; break
        case 'lt':         cond.lt          = coerceValue(value) as number | string; break
        case 'lte':        cond.lte         = coerceValue(value) as number | string; break
        case 'in':         cond.in          = value.split(',').map((s) => s.trim()); break
        case 'startsWith': cond.startsWith  = value; break
        case 'endsWith':   cond.endsWith    = value; break
      }
    } else {
      // Treat plain ?field=val as eq filter (skip internal params)
      const skip = new Set(['sort', 'cursor', 'limit', 'include'])
      if (!skip.has(key)) {
        if (!filters[key]) filters[key] = {}
        filters[key]!.eq = coerceValue(value)
      }
    }
  }

  return { filters, sorts, pagination: { cursor, limit }, include }
}

/** Converts a ParsedQuery into a Prisma-compatible where/orderBy/cursor/take object. */
export function toPrismaQuery(query: ParsedQuery): {
  where: Record<string, unknown>
  orderBy: Record<string, string>[]
  cursor: { id: string } | undefined
  take: number
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
    if (cond.startsWith !== undefined) prismaField['startsWith'] = cond.startsWith
    if (cond.endsWith   !== undefined) prismaField['endsWith']   = cond.endsWith
    where[field] = prismaField
  }

  const orderBy = query.sorts.map(({ field, direction }) => ({ [field]: direction }))
  const cursor = query.pagination.cursor ? { id: query.pagination.cursor } : undefined

  return { where, orderBy, cursor, take: query.pagination.limit }
}
