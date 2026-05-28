import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Hono } from 'hono'
import { createRuntime, MemoryUserStore, MemoryRefreshTokenStore } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

// ─────────────────────────────────────────────────────────────────────────────
// Spec used by most of the route-level Phase 2.2 tests
// ─────────────────────────────────────────────────────────────────────────────

const productSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'phase-2-2-products',
  resources: [
    {
      name: 'Product',
      fields: {
        title:    { type: 'string',  required: true },
        category: { type: 'string',  required: true },
        price:    { type: 'number',  required: true },
        inStock:  { type: 'boolean', required: false, default: true },
        status:   { type: 'enum', values: ['draft', 'active', 'archived'], default: 'active' },
      },
      searchable: ['title'],
    },
  ],
  features: {
    search: { enabled: true },
    pagination: { defaultLimit: 5, maxLimit: 50 },
  },
}

async function seedProducts(app: Hono, rows: Array<Record<string, unknown>>): Promise<string[]> {
  const ids: string[] = []
  for (const row of rows) {
    const res = await app.request('/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    })
    const body = await res.json() as { data: { id: string } }
    ids.push(body.data.id)
  }
  return ids
}

interface ProductsListBody {
  data: Array<Record<string, unknown>>
  count: number
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
  }
  nextCursor?: string
}

describe('Phase 2.2 — filters via routes', () => {
  let app: Hono
  beforeAll(async () => {
    const rt = createRuntime(productSpec, { enableLogging: false, enableDocs: false })
    app = rt.app
    await seedProducts(app, [
      { title: 'Running Shoes',  category: 'shoes',       price: 80,  inStock: true,  status: 'active' },
      { title: 'Hiking Boots',   category: 'shoes',       price: 150, inStock: false, status: 'active' },
      { title: 'Smart Phone',    category: 'electronics', price: 599, inStock: true,  status: 'active' },
      { title: 'Phone Case',     category: 'electronics', price: 19,  inStock: true,  status: 'draft' },
      { title: 'Laptop',         category: 'electronics', price: 999, inStock: false, status: 'archived' },
      { title: 'Tablet',         category: 'electronics', price: 499, inStock: true,  status: 'active' },
    ])
  })

  it('filters by simple equality (?category=shoes)', async () => {
    const res = await app.request('/products?category=shoes')
    expect(res.status).toBe(200)
    const body = await res.json() as ProductsListBody
    expect(body.data).toHaveLength(2)
    expect(body.data.every((p) => p['category'] === 'shoes')).toBe(true)
  })

  it('combines AND on multiple plain filters', async () => {
    const res = await app.request('/products?category=shoes&inStock=true')
    expect(res.status).toBe(200)
    const body = await res.json() as ProductsListBody
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.['title']).toBe('Running Shoes')
  })

  it('?field[gt]= excludes the boundary', async () => {
    const res = await app.request('/products?price[gt]=499')
    const body = await res.json() as ProductsListBody
    expect(body.data.every((p) => (p['price'] as number) > 499)).toBe(true)
    expect(body.count).toBe(2)
  })

  it('?field[gte]= includes the boundary', async () => {
    const res = await app.request('/products?price[gte]=499')
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(3)
  })

  it('?field[lt]= and ?field[lte]= invert the comparison', async () => {
    const ltRes = await app.request('/products?price[lt]=80')
    const lteRes = await app.request('/products?price[lte]=80')
    const lt = await ltRes.json() as ProductsListBody
    const lte = await lteRes.json() as ProductsListBody
    expect(lt.count).toBe(1)   // 19
    expect(lte.count).toBe(2)  // 19, 80
  })

  it('?field[contains]= is case-insensitive', async () => {
    const res = await app.request('/products?title[contains]=PHONE')
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(2)
    expect(body.data.every((p) => String(p['title']).toLowerCase().includes('phone'))).toBe(true)
  })

  it('?field[in]= matches set membership', async () => {
    const res = await app.request('/products?status[in]=draft,archived')
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(2)
  })

  it('?field[notin]= excludes set members', async () => {
    const res = await app.request('/products?status[notin]=draft,archived')
    const body = await res.json() as ProductsListBody
    expect(body.data.every((p) => p['status'] === 'active')).toBe(true)
    expect(body.count).toBe(4)
  })

  it('?field[ne]= is inequality', async () => {
    const res = await app.request('/products?category[ne]=shoes')
    const body = await res.json() as ProductsListBody
    expect(body.data.every((p) => p['category'] !== 'shoes')).toBe(true)
  })

  it('range query (gte + lte on the same field) intersects', async () => {
    const res = await app.request('/products?price[gte]=100&price[lte]=600')
    const body = await res.json() as ProductsListBody
    expect(body.data.every((p) => {
      const price = p['price'] as number
      return price >= 100 && price <= 600
    })).toBe(true)
    expect(body.count).toBe(3) // 150, 599, 499
  })
})

describe('Phase 2.2 — search via routes (?q=)', () => {
  let app: Hono
  beforeAll(async () => {
    const rt = createRuntime(productSpec, { enableLogging: false, enableDocs: false })
    app = rt.app
    await seedProducts(app, [
      { title: 'Running Shoes',  category: 'shoes',       price: 80 },
      { title: 'Smart Phone',    category: 'electronics', price: 599 },
      { title: 'Phone Case',     category: 'electronics', price: 19 },
      { title: 'Laptop',         category: 'electronics', price: 999 },
    ])
  })

  it('?q= matches across searchable fields (case-insensitive contains)', async () => {
    const res = await app.request('/products?q=phone')
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(2)
    expect(body.data.every((p) => String(p['title']).toLowerCase().includes('phone'))).toBe(true)
  })

  it('?q= returns empty data when nothing matches', async () => {
    const res = await app.request('/products?q=nonexistent')
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(0)
    expect(body.data).toEqual([])
  })

  it('?q= is ignored when features.search.enabled is false', async () => {
    const spec: ZeroAPISpec = {
      ...productSpec,
      features: { ...productSpec.features, search: { enabled: false } },
    }
    const rt = createRuntime(spec, { enableLogging: false, enableDocs: false })
    await seedProducts(rt.app, [
      { title: 'Smart Phone', category: 'electronics', price: 599 },
      { title: 'Laptop',      category: 'electronics', price: 999 },
    ])
    const res = await rt.app.request('/products?q=phone')
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(2) // ?q= had no effect — both items returned
  })

  it('?q= is ignored when resource has no searchable[]', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'no-searchable',
      resources: [{
        name: 'Widget',
        fields: { label: { type: 'string', required: true } },
      }],
      features: { search: { enabled: true } },
    }
    const rt = createRuntime(spec, { enableLogging: false, enableDocs: false })
    await rt.app.request('/widgets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'A' }),
    })
    const res = await rt.app.request('/widgets?q=A')
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(1)
  })
})

describe('Phase 2.2 — sort via routes', () => {
  let app: Hono
  beforeAll(async () => {
    const rt = createRuntime(productSpec, { enableLogging: false, enableDocs: false })
    app = rt.app
    await seedProducts(app, [
      { title: 'Banana', category: 'food', price: 1 },
      { title: 'Apple',  category: 'food', price: 3 },
      { title: 'Cherry', category: 'food', price: 2 },
    ])
  })

  it('?sort=price returns ascending', async () => {
    const res = await app.request('/products?sort=price')
    const body = await res.json() as ProductsListBody
    expect(body.data.map((p) => p['price'])).toEqual([1, 2, 3])
  })

  it('?sort=-price returns descending', async () => {
    const res = await app.request('/products?sort=-price')
    const body = await res.json() as ProductsListBody
    expect(body.data.map((p) => p['price'])).toEqual([3, 2, 1])
  })

  it('?sort=-price,title sorts by multiple fields', async () => {
    const rt = createRuntime(productSpec, { enableLogging: false, enableDocs: false })
    await seedProducts(rt.app, [
      { title: 'B', category: 'food', price: 10 },
      { title: 'A', category: 'food', price: 10 },
      { title: 'Z', category: 'food', price: 5 },
    ])
    const res = await rt.app.request('/products?sort=-price,title')
    const body = await res.json() as ProductsListBody
    expect(body.data.map((p) => p['title'])).toEqual(['A', 'B', 'Z'])
  })

  it('legacy ?sort=price:desc still works', async () => {
    const res = await app.request('/products?sort=price:desc')
    const body = await res.json() as ProductsListBody
    expect(body.data.map((p) => p['price'])).toEqual([3, 2, 1])
  })
})

describe('Phase 2.2 — pagination via routes', () => {
  let app: Hono
  beforeAll(async () => {
    const rt = createRuntime(productSpec, { enableLogging: false, enableDocs: false })
    app = rt.app
    const rows: Array<Record<string, unknown>> = []
    for (let i = 1; i <= 12; i++) {
      rows.push({ title: `Item ${i}`, category: 'gen', price: i })
    }
    await seedProducts(app, rows)
  })

  it('?page=&limit= returns the requested slice and full meta', async () => {
    const res = await app.request('/products?page=2&limit=5&sort=price')
    const body = await res.json() as ProductsListBody
    expect(body.pagination).toEqual({
      page: 2,
      limit: 5,
      total: 12,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    })
    expect(body.data.map((p) => p['price'])).toEqual([6, 7, 8, 9, 10])
  })

  it('caps ?limit= at features.pagination.maxLimit (no error, plafonnement)', async () => {
    const res = await app.request('/products?limit=9999')
    const body = await res.json() as ProductsListBody
    expect(res.status).toBe(200)
    expect(body.pagination.limit).toBe(50) // maxLimit from features
  })

  it('uses features.pagination.defaultLimit when ?limit= is missing', async () => {
    const res = await app.request('/products')
    const body = await res.json() as ProductsListBody
    expect(body.pagination.limit).toBe(5) // defaultLimit from features
  })

  it('hasPrev=false on page 1', async () => {
    const res = await app.request('/products?page=1&limit=5')
    const body = await res.json() as ProductsListBody
    expect(body.pagination.hasPrev).toBe(false)
    expect(body.pagination.hasNext).toBe(true)
  })

  it('hasNext=false on the last page', async () => {
    const res = await app.request('/products?page=3&limit=5')
    const body = await res.json() as ProductsListBody
    expect(body.pagination.hasNext).toBe(false)
    expect(body.pagination.hasPrev).toBe(true)
  })

  it('returns count for backward compatibility', async () => {
    const res = await app.request('/products?page=1&limit=5')
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(12)
  })

  it('cursor mode is preserved when ?page= is not provided', async () => {
    const res = await app.request('/products?limit=5&sort=price')
    const body = await res.json() as ProductsListBody
    expect(body.nextCursor).toBeTruthy()
    expect(body.pagination.total).toBe(12)
  })
})

describe('Phase 2.2 — combined query', () => {
  let app: Hono
  beforeAll(async () => {
    const rt = createRuntime(productSpec, { enableLogging: false, enableDocs: false })
    app = rt.app
    await seedProducts(app, [
      { title: 'Running Shoes',  category: 'shoes',       price: 80 },
      { title: 'Walking Shoes',  category: 'shoes',       price: 120 },
      { title: 'Hiking Boots',   category: 'shoes',       price: 150 },
      { title: 'Running Watch',  category: 'electronics', price: 250 },
      { title: 'Trail Shoes',    category: 'shoes',       price: 90 },
      { title: 'Tennis Shoes',   category: 'shoes',       price: 70 }, // below 50? no
    ])
  })

  it('category=shoes & price[gte]=50 & q=running & sort=-price & page=1 & limit=10', async () => {
    const res = await app.request(
      '/products?category=shoes&price[gte]=50&q=running&sort=-price&page=1&limit=10',
    )
    expect(res.status).toBe(200)
    const body = await res.json() as ProductsListBody
    // Only "Running Shoes" matches category=shoes AND title contains "running"
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.['title']).toBe('Running Shoes')
    expect(body.pagination.page).toBe(1)
    expect(body.pagination.limit).toBe(10)
    expect(body.pagination.total).toBe(1)
  })
})

describe('Phase 2.2 — validation errors', () => {
  let app: Hono
  beforeAll(async () => {
    const rt = createRuntime(productSpec, { enableLogging: false, enableDocs: false })
    app = rt.app
  })

  it('?unknownField=x → 400 Unknown field', async () => {
    const res = await app.request('/products?bogusField=1')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Unknown field: bogusField')
  })

  it('?field[bogus]=v → 400 Unknown operator', async () => {
    const res = await app.request('/products?price[bogus]=10')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Unknown operator: bogus')
  })

  it('?sort=unknownField → 400 Unknown field', async () => {
    const res = await app.request('/products?sort=foo')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Unknown field: foo')
  })

  it('allows declared FK fields in filters', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'fk-test',
      resources: [
        { name: 'Author', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Book',
          fields: { title: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Author', field: 'authorId' }],
        },
      ],
    }
    const rt = createRuntime(spec, { enableLogging: false, enableDocs: false })
    const res = await rt.app.request('/books?authorId=abc')
    expect(res.status).toBe(200) // authorId IS a recognised FK column
  })

  it('allows id, createdAt, updatedAt in filters', async () => {
    const res = await app.request('/products?id[in]=a,b,c&sort=-createdAt')
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ownOnly + filter — RBAC scope must be applied BEFORE user-supplied filters
// (a vendor that filters cannot see another vendor's rows).
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2.2 — ownOnly + filter (no leak)', () => {
  const SAVED_JWT_SECRET = process.env['JWT_SECRET']
  const SAVED_NODE_ENV = process.env['NODE_ENV']

  afterAll(() => {
    if (SAVED_JWT_SECRET === undefined) delete process.env['JWT_SECRET']
    else process.env['JWT_SECRET'] = SAVED_JWT_SECRET
    if (SAVED_NODE_ENV === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = SAVED_NODE_ENV
  })

  const spec: ZeroAPISpec = {
    version: '1.0.0',
    name: 'ownonly-filter',
    auth: {
      enabled: true,
      strategies: ['jwt'],
      jwt: { enabled: true, secretEnv: 'JWT_SECRET' },
    },
    resources: [
      {
        name: 'Listing',
        fields: {
          title: { type: 'string', required: true },
          price: { type: 'number', required: true },
        },
      },
    ],
    permissions: [
      {
        resource: 'Listing',
        rules: [
          { role: 'vendor', actions: ['create', 'read', 'update'], ownOnly: true },
        ],
      },
    ],
  }

  async function bootstrapVendor(
    userStore: MemoryUserStore,
    email: string,
  ): Promise<{ userId: string; token: string }> {
    const u = await userStore.create({
      email, passwordHash: 'irrelevant', salt: 'irrelevant', role: 'vendor',
    })
    const { generateAccessToken } = await import('../../src/auth/jwt.js')
    const token = await generateAccessToken(u.id, email, 'vendor', 'phase-2-2-secret', 3600)
    return { userId: u.id, token }
  }

  it('a vendor that filters cannot see another vendor\'s rows', async () => {
    process.env['JWT_SECRET'] = 'phase-2-2-secret'
    const userStore = new MemoryUserStore()
    const rt = createRuntime(spec, {
      enableLogging: false,
      enableDocs: false,
      enableHelmet: false,
      enableCors: false,
      enableSanitize: false,
      userStore,
      refreshTokenStore: new MemoryRefreshTokenStore(),
      jwtSecretLogger: () => { /* silent */ },
    })
    const app = rt.app

    const alice = await bootstrapVendor(userStore, 'alice@example.com')
    const bob   = await bootstrapVendor(userStore, 'bob@example.com')

    // Each vendor creates one listing of the same title.
    for (const v of [alice, bob]) {
      const r = await app.request('/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${v.token}` },
        body: JSON.stringify({ title: 'Shared', price: 100 }),
      })
      expect(r.status).toBe(201)
    }

    // Alice filters by the shared title — should only see her own row.
    const res = await app.request('/listings?title[contains]=Shared', {
      headers: { authorization: `Bearer ${alice.token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(1)
    expect(body.data[0]?.['userId']).toBe(alice.userId)
  })

  it('a vendor cannot inject another vendor\'s userId via filter', async () => {
    process.env['JWT_SECRET'] = 'phase-2-2-secret'
    const userStore = new MemoryUserStore()
    const rt = createRuntime(spec, {
      enableLogging: false,
      enableDocs: false,
      enableHelmet: false,
      enableCors: false,
      enableSanitize: false,
      userStore,
      refreshTokenStore: new MemoryRefreshTokenStore(),
      jwtSecretLogger: () => { /* silent */ },
    })
    const app = rt.app

    const alice = await bootstrapVendor(userStore, 'alice2@example.com')
    const bob   = await bootstrapVendor(userStore, 'bob2@example.com')

    const created = await app.request('/listings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ title: 'Bob Item', price: 50 }),
    })
    expect(created.status).toBe(201)

    // Alice tries to filter by Bob's userId — ownership filter must still scope to her.
    const res = await app.request(`/listings?userId=${bob.userId}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as ProductsListBody
    expect(body.count).toBe(0) // no leak
  })
})
