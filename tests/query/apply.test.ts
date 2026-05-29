import { describe, it, expect } from 'vitest'
import { applyFilters, applySorts, applyPagination, applyQuery, applySearch } from '../../src/query/apply.js'
import { parseQueryParams } from '../../src/query/builder.js'
import type { ResourceDefinition } from '../../src/types/spec.js'

const items = [
  { id: 'a', title: 'Phone Case', price: 9.99,  status: 'active',  name: 'Alice' },
  { id: 'b', title: 'Smart Phone', price: 299,   status: 'active',  name: 'Bob' },
  { id: 'c', title: 'Tablet',    price: 499,   status: 'pending', name: 'Carol' },
  { id: 'd', title: 'Laptop',    price: 999,   status: 'active',  name: 'Dave' },
  { id: 'e', title: 'Earbuds',    price: 79.99, status: 'inactive', name: 'Eve' },
]

describe('applyFilters', () => {
  it('filters by contains (case-insensitive)', () => {
    const result = applyFilters(items, { title: { contains: 'phone' } })
    expect(result).toHaveLength(2)
    expect(result.map(i => i['id'])).toEqual(['a', 'b'])
  })

  it('filters by gte', () => {
    const result = applyFilters(items, { price: { gte: 299 } })
    expect(result).toHaveLength(3)
  })

  it('filters by lte', () => {
    const result = applyFilters(items, { price: { lte: 100 } })
    expect(result).toHaveLength(2)
  })

  it('filters by range (gte + lte)', () => {
    const result = applyFilters(items, { price: { gte: 100, lte: 500 } })
    expect(result).toHaveLength(2)
  })

  it('filters by in set', () => {
    const result = applyFilters(items, { status: { in: ['active', 'pending'] } })
    expect(result).toHaveLength(4)
  })

  it('filters by eq', () => {
    const result = applyFilters(items, { status: { eq: 'inactive' } })
    expect(result).toHaveLength(1)
    expect(result[0]?.['id']).toBe('e')
  })

  it('filters by ne', () => {
    const result = applyFilters(items, { status: { ne: 'active' } })
    expect(result).toHaveLength(2)
  })

  it('filters by startsWith', () => {
    const result = applyFilters(items, { title: { startsWith: 'smart' } })
    expect(result).toHaveLength(1)
  })

  it('filters by endsWith', () => {
    const result = applyFilters(items, { name: { endsWith: 'ob' } })
    expect(result).toHaveLength(1)
    expect(result[0]?.['id']).toBe('b')
  })

  it('returns all items when filters is empty', () => {
    expect(applyFilters(items, {})).toHaveLength(5)
  })
})

describe('applySorts', () => {
  it('sorts asc by price', () => {
    const sorted = applySorts(items, [{ field: 'price', direction: 'asc' }])
    expect(sorted.map(i => i['id'])).toEqual(['a', 'e', 'b', 'c', 'd'])
  })

  it('sorts desc by price', () => {
    const sorted = applySorts(items, [{ field: 'price', direction: 'desc' }])
    expect(sorted[0]?.['id']).toBe('d')
  })

  it('sorts by string field', () => {
    const sorted = applySorts(items, [{ field: 'name', direction: 'asc' }])
    expect(sorted[0]?.['id']).toBe('a')  // Alice
  })

  it('returns original order when sorts is empty', () => {
    expect(applySorts(items, [])).toHaveLength(5)
  })
})

describe('applyPagination', () => {
  const sorted = [...items] // already in order a,b,c,d,e

  it('returns first page when no cursor', () => {
    const { data, nextCursor } = applyPagination(sorted, { limit: 2 })
    expect(data).toHaveLength(2)
    expect(data[0]?.['id']).toBe('a')
    expect(nextCursor).toBe('b')
  })

  it('returns next page from cursor', () => {
    const { data } = applyPagination(sorted, { cursor: 'b', limit: 2 })
    expect(data.map(i => i['id'])).toEqual(['c', 'd'])
  })

  it('returns null nextCursor on last page', () => {
    const { nextCursor } = applyPagination(sorted, { cursor: 'd', limit: 5 })
    expect(nextCursor).toBeNull()
  })

  it('returns empty array when cursor is last item', () => {
    const { data } = applyPagination(sorted, { cursor: 'e', limit: 5 })
    expect(data).toHaveLength(0)
  })
})

describe('applyQuery (combined)', () => {
  it('filters then sorts then paginates', () => {
    const q = parseQueryParams('http://localhost/?status[eq]=active&sort=price:desc&limit=2')
    const { data, count, nextCursor } = applyQuery(items, q)
    expect(count).toBe(3)           // 3 active items
    expect(data).toHaveLength(2)    // first page of 2
    expect(nextCursor).toBeTruthy()
  })

  it('count reflects filtered total', () => {
    const q = parseQueryParams('http://localhost/?price[gte]=300')
    const { count } = applyQuery(items, q)
    expect(count).toBe(2)
  })
})

// ── Phase 2.2 ────────────────────────────────────────────────────────────────

describe('Phase 2.2 — notin operator', () => {
  it('excludes items in the notin set', () => {
    const result = applyFilters(items, { status: { notin: ['inactive', 'pending'] } })
    expect(result.map((r) => r['id'])).toEqual(['a', 'b', 'd']) // only active
  })

  it('combines with eq', () => {
    const result = applyFilters(items, {
      status: { eq: 'active' },
      name:   { notin: ['Alice'] },
    })
    expect(result.map((r) => r['id'])).toEqual(['b', 'd'])
  })
})

describe('Phase 2.2 — applySearch', () => {
  const resource: ResourceDefinition = {
    name: 'Product',
    fields: { title: { type: 'string' }, body: { type: 'text' }, name: { type: 'string' } },
    searchable: ['title', 'name'],
  }

  it('matches case-insensitively across searchable fields (OR)', () => {
    const result = applySearch(items, 'phone', resource, { search: { enabled: true } })
    // "Phone Case", "Smart Phone" — both match on title
    expect(result.map((r) => r['id'])).toEqual(['a', 'b'])
  })

  it('matches against any searchable field (OR semantics)', () => {
    const result = applySearch(items, 'carol', resource, { search: { enabled: true } })
    expect(result).toHaveLength(1)
    expect(result[0]?.['id']).toBe('c')
  })

  it('returns all items when q is empty', () => {
    expect(applySearch(items, '', resource, { search: { enabled: true } })).toHaveLength(5)
    expect(applySearch(items, undefined, resource, { search: { enabled: true } })).toHaveLength(5)
  })

  it('does nothing when search.enabled is false', () => {
    const result = applySearch(items, 'phone', resource, { search: { enabled: false } })
    expect(result).toHaveLength(5)
  })

  it('does nothing when features is absent', () => {
    expect(applySearch(items, 'phone', resource)).toHaveLength(5)
  })

  it('does nothing when resource has no searchable[]', () => {
    const noSearch: ResourceDefinition = { name: 'X', fields: { title: { type: 'string' } } }
    expect(applySearch(items, 'phone', noSearch, { search: { enabled: true } })).toHaveLength(5)
  })

  it('ignores null/undefined field values', () => {
    const sparse = [
      { id: '1', title: null },
      { id: '2', title: 'phone' },
      { id: '3' },
    ]
    const result = applySearch(sparse, 'phone', resource, { search: { enabled: true } })
    expect(result).toHaveLength(1)
    expect(result[0]?.['id']).toBe('2')
  })
})

describe('Phase 2.2 — offset pagination & metadata', () => {
  it('returns the requested page slice when page is set', () => {
    const q = parseQueryParams('http://localhost/?page=2&limit=2')
    const { data, pagination } = applyQuery(items, q)
    expect(data.map((r) => r['id'])).toEqual(['c', 'd'])
    expect(pagination.page).toBe(2)
    expect(pagination.limit).toBe(2)
    expect(pagination.total).toBe(5)
    expect(pagination.totalPages).toBe(3)
    expect(pagination.hasNext).toBe(true)
    expect(pagination.hasPrev).toBe(true)
  })

  it('hasNext=false on the last page', () => {
    const q = parseQueryParams('http://localhost/?page=3&limit=2')
    const { pagination } = applyQuery(items, q)
    expect(pagination.hasNext).toBe(false)
    expect(pagination.hasPrev).toBe(true)
  })

  it('hasPrev=false on page 1', () => {
    const q = parseQueryParams('http://localhost/?page=1&limit=2')
    const { pagination } = applyQuery(items, q)
    expect(pagination.hasPrev).toBe(false)
    expect(pagination.hasNext).toBe(true)
  })

  it('totalPages is rounded up', () => {
    // 5 items, limit 2 → 3 pages
    const q = parseQueryParams('http://localhost/?page=1&limit=2')
    const { pagination } = applyQuery(items, q)
    expect(pagination.totalPages).toBe(3)
  })

  it('does not emit nextCursor in offset mode', () => {
    const q = parseQueryParams('http://localhost/?page=1&limit=2')
    const { nextCursor } = applyQuery(items, q)
    expect(nextCursor).toBeNull()
  })

  it('returns empty data when page exceeds totalPages', () => {
    const q = parseQueryParams('http://localhost/?page=99&limit=2')
    const { data, pagination } = applyQuery(items, q)
    expect(data).toEqual([])
    expect(pagination.totalPages).toBe(3)
  })

  it('pagination meta is populated in cursor mode too', () => {
    const q = parseQueryParams('http://localhost/?limit=2')
    const { pagination, nextCursor } = applyQuery(items, q)
    expect(pagination.total).toBe(5)
    expect(pagination.limit).toBe(2)
    expect(nextCursor).toBeTruthy() // cursor mode preserved
  })
})

describe('Phase 2.2 — combined query (filter → search → sort → paginate)', () => {
  const resource: ResourceDefinition = {
    name: 'Product',
    fields: { title: { type: 'string' }, status: { type: 'string' } },
    searchable: ['title', 'name'],
  }

  it('applies the full pipeline in order', () => {
    const q = parseQueryParams(
      'http://localhost/?status=active&q=phone&sort=-price&page=1&limit=10',
    )
    const { data, count, pagination } = applyQuery(items, q, {
      resource,
      features: { search: { enabled: true } },
    })
    // status=active filters to [a, b, d]; q=phone narrows to [a, b]; sort=-price → [b, a]
    expect(data.map((r) => r['id'])).toEqual(['b', 'a'])
    expect(count).toBe(2)
    expect(pagination.total).toBe(2)
  })
})

describe('Deterministic cursor pagination with duplicate sort values', () => {
  // All 4 items share the same price — without an id tiebreak, sort order is
  // non-deterministic and cursors can skip or duplicate records at page boundaries.
  const tied = [
    { id: 'w3', price: 50 },
    { id: 'w1', price: 50 },
    { id: 'w4', price: 50 },
    { id: 'w2', price: 50 },
  ]

  it('covers all items exactly once across two pages when sort keys tie', () => {
    // Page 1 — no cursor; tiebreak id:asc forces stable order: w1,w2,w3,w4
    const q1 = parseQueryParams('http://localhost/?sort=price:asc&limit=2')
    const r1 = applyQuery(tied, q1)
    expect(r1.data).toHaveLength(2)
    expect(r1.nextCursor).toBeTruthy()

    // Page 2 — cursor from page 1
    const q2 = parseQueryParams(`http://localhost/?sort=price:asc&limit=2&cursor=${r1.nextCursor}`)
    const r2 = applyQuery(tied, q2)
    expect(r2.data).toHaveLength(2)
    expect(r2.nextCursor).toBeNull()

    // All 4 items seen, no duplicates
    const ids = [...r1.data.map(i => i['id']), ...r2.data.map(i => i['id'])]
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
  })

  it('stable order is consistent: first page always yields the lexicographically smallest ids', () => {
    const q = parseQueryParams('http://localhost/?sort=price:asc&limit=2')
    const { data } = applyQuery(tied, q)
    expect(data[0]?.['id']).toBe('w1')
    expect(data[1]?.['id']).toBe('w2')
  })
})
