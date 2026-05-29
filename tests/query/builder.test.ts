import { describe, it, expect } from 'vitest'
import { parseQueryParams, toPrismaQuery } from '../../src/query/builder.js'

describe('parseQueryParams', () => {
  it('parses field[contains] filter', () => {
    const q = parseQueryParams('http://localhost/?title[contains]=phone')
    expect(q.filters['title']?.contains).toBe('phone')
  })

  it('parses field[gte] and field[lte] filters', () => {
    const q = parseQueryParams('http://localhost/?price[gte]=100&price[lte]=500')
    expect(q.filters['price']?.gte).toBe(100)
    expect(q.filters['price']?.lte).toBe(500)
  })

  it('parses field[in] as array', () => {
    const q = parseQueryParams('http://localhost/?status[in]=active,pending')
    expect(q.filters['status']?.in).toEqual(['active', 'pending'])
  })

  it('parses field[startsWith]', () => {
    const q = parseQueryParams('http://localhost/?name[startsWith]=John')
    expect(q.filters['name']?.startsWith).toBe('John')
  })

  it('parses field[endsWith]', () => {
    const q = parseQueryParams('http://localhost/?email[endsWith]=.com')
    expect(q.filters['email']?.endsWith).toBe('.com')
  })

  it('parses multiple sort specs', () => {
    const q = parseQueryParams('http://localhost/?sort=price:asc,createdAt:desc')
    expect(q.sorts).toEqual([
      { field: 'price', direction: 'asc' },
      { field: 'createdAt', direction: 'desc' },
    ])
  })

  it('defaults sort direction to asc when omitted', () => {
    const q = parseQueryParams('http://localhost/?sort=name')
    expect(q.sorts[0]?.direction).toBe('asc')
  })

  it('parses cursor and limit', () => {
    const q = parseQueryParams('http://localhost/?cursor=cuid_xyz&limit=20')
    expect(q.pagination.cursor).toBe('cuid_xyz')
    expect(q.pagination.limit).toBe(20)
  })

  it('caps limit at 100', () => {
    const q = parseQueryParams('http://localhost/?limit=999')
    expect(q.pagination.limit).toBe(100)
  })

  it('defaults limit to 20', () => {
    const q = parseQueryParams('http://localhost/')
    expect(q.pagination.limit).toBe(20)
  })

  it('parses ?include= as array', () => {
    const q = parseQueryParams('http://localhost/?include=products,user')
    expect(q.include).toEqual(['products', 'user'])
  })

  it('parses plain ?field=val as eq filter', () => {
    const q = parseQueryParams('http://localhost/?status=active')
    expect(q.filters['status']?.eq).toBe('active')
  })

  it('accepts URLSearchParams directly', () => {
    const params = new URLSearchParams('price[gte]=50')
    const q = parseQueryParams(params)
    expect(q.filters['price']?.gte).toBe(50)
  })
})

describe('toPrismaQuery', () => {
  it('maps filters to Prisma where object', () => {
    const q = parseQueryParams('http://localhost/?title[contains]=phone&price[gte]=100')
    const prisma = toPrismaQuery(q)
    expect((prisma.where['title'] as Record<string, unknown>)['contains']).toBe('phone')
    expect((prisma.where['price'] as Record<string, unknown>)['gte']).toBe(100)
  })

  it('maps sorts to orderBy array', () => {
    const q = parseQueryParams('http://localhost/?sort=price:desc')
    const prisma = toPrismaQuery(q)
    expect(prisma.orderBy).toEqual([{ price: 'desc' }])
  })

  it('sets cursor when provided', () => {
    const q = parseQueryParams('http://localhost/?cursor=abc')
    const prisma = toPrismaQuery(q)
    expect(prisma.cursor).toEqual({ id: 'abc' })
  })

  it('sets take from limit', () => {
    const q = parseQueryParams('http://localhost/?limit=15')
    const prisma = toPrismaQuery(q)
    expect(prisma.take).toBe(15)
  })

  it('maps notin to Prisma notIn', () => {
    const q = parseQueryParams('http://localhost/?status[notin]=draft,archived')
    const prisma = toPrismaQuery(q)
    expect((prisma.where['status'] as Record<string, unknown>)['notIn']).toEqual(['draft', 'archived'])
  })

  it('computes skip from page in offset mode', () => {
    const q = parseQueryParams('http://localhost/?page=3&limit=10')
    const prisma = toPrismaQuery(q)
    expect(prisma.skip).toBe(20)
    expect(prisma.take).toBe(10)
  })

  it('skip is 0 when cursor is set (cursor mode wins)', () => {
    const q = parseQueryParams('http://localhost/?cursor=abc&page=5&limit=10')
    const prisma = toPrismaQuery(q)
    expect(prisma.skip).toBe(0)
    expect(prisma.cursor).toEqual({ id: 'abc' })
  })
})

// ── Phase 2.2 additions ──────────────────────────────────────────────────────

describe('Phase 2.2 — operators', () => {
  it('parses field[notin] as array', () => {
    const q = parseQueryParams('http://localhost/?status[notin]=draft,deleted')
    expect(q.filters['status']?.notin).toEqual(['draft', 'deleted'])
  })

  it('records unknown operators in unknownOperators', () => {
    const q = parseQueryParams('http://localhost/?status[lol]=foo')
    expect(q.unknownOperators).toEqual([{ field: 'status', operator: 'lol' }])
    expect(q.filters['status']).toBeUndefined()
  })

  it('records multiple unknown operators', () => {
    const q = parseQueryParams('http://localhost/?a[bogus]=1&b[fake]=2&c[eq]=3')
    expect(q.unknownOperators).toHaveLength(2)
    expect(q.filters['c']?.eq).toBe(3)
  })

  it('unknownOperators is always an array (empty by default)', () => {
    const q = parseQueryParams('http://localhost/?status=active')
    expect(q.unknownOperators).toEqual([])
  })
})

describe('Phase 2.2 — search (?q=)', () => {
  it('parses ?q= as search term', () => {
    const q = parseQueryParams('http://localhost/?q=iphone')
    expect(q.q).toBe('iphone')
  })

  it('q is undefined when absent', () => {
    const q = parseQueryParams('http://localhost/')
    expect(q.q).toBeUndefined()
  })

  it('q does not leak into filters', () => {
    const q = parseQueryParams('http://localhost/?q=iphone&status=active')
    expect(q.filters['q']).toBeUndefined()
    expect(q.filters['status']?.eq).toBe('active')
  })
})

describe('Phase 2.2 — sort syntax', () => {
  it('parses -field as descending', () => {
    const q = parseQueryParams('http://localhost/?sort=-price')
    expect(q.sorts).toEqual([{ field: 'price', direction: 'desc' }])
  })

  it('parses -field,otherField (multi)', () => {
    const q = parseQueryParams('http://localhost/?sort=-createdAt,title')
    expect(q.sorts).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'title',     direction: 'asc'  },
    ])
  })

  it('mixes legacy and prefix syntax', () => {
    const q = parseQueryParams('http://localhost/?sort=-price,title:desc')
    expect(q.sorts).toEqual([
      { field: 'price', direction: 'desc' },
      { field: 'title', direction: 'desc' },
    ])
  })
})

describe('Phase 2.2 — offset pagination', () => {
  it('parses ?page= into pagination.page', () => {
    const q = parseQueryParams('http://localhost/?page=3&limit=10')
    expect(q.pagination.page).toBe(3)
    expect(q.pagination.limit).toBe(10)
  })

  it('page is undefined when absent (cursor mode default)', () => {
    const q = parseQueryParams('http://localhost/?limit=10')
    expect(q.pagination.page).toBeUndefined()
  })

  it('ignores page < 1', () => {
    const q = parseQueryParams('http://localhost/?page=0')
    expect(q.pagination.page).toBeUndefined()
  })

  it('ignores non-numeric page', () => {
    const q = parseQueryParams('http://localhost/?page=abc')
    expect(q.pagination.page).toBeUndefined()
  })
})

describe('Phase 2.2 — feature-driven pagination defaults', () => {
  it('uses defaultLimit option when ?limit= is missing', () => {
    const q = parseQueryParams('http://localhost/', { defaultLimit: 50 })
    expect(q.pagination.limit).toBe(50)
  })

  it('caps ?limit= at maxLimit option', () => {
    const q = parseQueryParams('http://localhost/?limit=9999', { maxLimit: 200 })
    expect(q.pagination.limit).toBe(200)
  })

  it('falls back to built-in 20/100 when options are not provided', () => {
    expect(parseQueryParams('http://localhost/').pagination.limit).toBe(20)
    expect(parseQueryParams('http://localhost/?limit=9999').pagination.limit).toBe(100)
  })
})
