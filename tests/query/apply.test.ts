import { describe, it, expect } from 'vitest'
import { applyFilters, applySorts, applyPagination, applyQuery } from '../../src/query/apply.js'
import { parseQueryParams } from '../../src/query/builder.js'

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
