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
})
