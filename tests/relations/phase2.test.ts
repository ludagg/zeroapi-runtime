import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../src/index.js'
import { parseSpec, ParseError } from '../../src/parser/index.js'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import { normalizeTopLevelRelations, validateIncludes } from '../../src/relations/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Nested endpoints (one-to-many / many-to-one)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2.1 — nested endpoints (one-to-many / many-to-one)', () => {
  const buildSpec = (): ZeroAPISpec => ({
    version: '1.0.0',
    name: 'nested-test',
    resources: [
      {
        name: 'User',
        fields: { name: { type: 'string', required: true } },
      },
      {
        name: 'Order',
        fields: { total: { type: 'number', required: true } },
        relations: [
          { type: 'manyToOne', resource: 'User', field: 'userId', required: false },
        ],
      },
    ],
  })

  it('GET /users/:userId/orders lists only that user\'s orders', async () => {
    const { app } = createRuntime(buildSpec(), { enableLogging: false, enableDocs: false })

    const u1 = await (await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    })).json() as { data: { id: string } }
    const u2 = await (await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    })).json() as { data: { id: string } }

    await app.request('/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 100, userId: u1.data.id }),
    })
    await app.request('/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 50, userId: u1.data.id }),
    })
    await app.request('/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 30, userId: u2.data.id }),
    })

    const res = await app.request(`/users/${u1.data.id}/orders`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ userId: string }>; count: number }
    expect(body.count).toBe(2)
    expect(body.data.every((o) => o.userId === u1.data.id)).toBe(true)
  })

  it('POST /users/:userId/orders forces userId from the URL', async () => {
    const { app } = createRuntime(buildSpec(), { enableLogging: false, enableDocs: false })

    const u1 = await (await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    })).json() as { data: { id: string } }
    const u2 = await (await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    })).json() as { data: { id: string } }

    // Body says userId=u2 but URL says u1 — URL wins.
    const res = await app.request(`/users/${u1.data.id}/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 99, userId: u2.data.id }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { userId: string; total: number } }
    expect(body.data.userId).toBe(u1.data.id)
    expect(body.data.total).toBe(99)
  })

  it('GET /users/:userId/orders/:id returns 404 when the order belongs to another user', async () => {
    const { app } = createRuntime(buildSpec(), { enableLogging: false, enableDocs: false })

    const u1 = await (await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    })).json() as { data: { id: string } }
    const u2 = await (await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    })).json() as { data: { id: string } }

    const order = await (await app.request('/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 25, userId: u1.data.id }),
    })).json() as { data: { id: string } }

    // Same id, wrong parent → 404
    const cross = await app.request(`/users/${u2.data.id}/orders/${order.data.id}`)
    expect(cross.status).toBe(404)

    // Right parent → 200
    const own = await app.request(`/users/${u1.data.id}/orders/${order.data.id}`)
    expect(own.status).toBe(200)
  })

  it('returns 404 when the parent itself does not exist', async () => {
    const { app } = createRuntime(buildSpec(), { enableLogging: false, enableDocs: false })
    const res = await app.request('/users/does-not-exist/orders')
    expect(res.status).toBe(404)
  })

  it('keeps the flat endpoint working alongside the nested one', async () => {
    const { app } = createRuntime(buildSpec(), { enableLogging: false, enableDocs: false })
    const flat = await app.request('/orders')
    expect(flat.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. ?include validation + ownOnly filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2.1 — ?include validation', () => {
  const spec: ZeroAPISpec = {
    version: '1.0.0', name: 'include-test',
    resources: [
      { name: 'Author', fields: { name: { type: 'string', required: true } } },
      {
        name: 'Book',
        fields: { title: { type: 'string', required: true } },
        relations: [{ type: 'manyToOne', resource: 'Author', field: 'authorId' }],
      },
    ],
  }

  it('validateIncludes() flags the first unknown name', () => {
    const res = validateIncludes(['Author', 'Mystery'], spec.resources[1]!)
    expect(res.ok).toBe(false)
    expect(res.unknown).toBe('Mystery')
  })

  it('GET ?include=unknown returns 400 with a clear message', async () => {
    const { app } = createRuntime(spec, { enableLogging: false, enableDocs: false })
    const res = await app.request('/books?include=ghost')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Unknown relation: ghost')
  })

  it('GET ?include=valid,unknown returns 400 (not partial success)', async () => {
    const { app } = createRuntime(spec, { enableLogging: false, enableDocs: false })
    const res = await app.request('/books?include=Author,ghost')
    expect(res.status).toBe(400)
  })

  it('GET /:id with an unknown include also returns 400', async () => {
    const { app } = createRuntime(spec, { enableLogging: false, enableDocs: false })
    const created = await (await app.request('/books', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X' }),
    })).json() as { data: { id: string } }
    const res = await app.request(`/books/${created.data.id}?include=ghost`)
    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. ownOnly respected on included relations (no leak)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2.1 — ownOnly is respected on ?include', () => {
  const spec: ZeroAPISpec = {
    version: '1.0.0', name: 'include-ownonly',
    auth: { jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
    resources: [
      {
        name: 'Catalog',
        fields: { name: { type: 'string', required: true } },
        relations: [{ type: 'oneToMany', resource: 'Note' }],
      },
      {
        name: 'Note',
        fields: { body: { type: 'string', required: true } },
        relations: [{ type: 'manyToOne', resource: 'Catalog', field: 'catalogId' }],
      },
    ],
    permissions: [
      {
        resource: 'Note',
        rules: [{ role: 'user', actions: ['create', 'read', 'update', 'delete'], ownOnly: true }],
      },
      {
        resource: 'Catalog',
        rules: [{ role: 'public', actions: ['read'] }, { role: 'user', actions: ['create', 'read'] }],
      },
    ],
  }

  it('drops notes the requester does not own from the include payload', async () => {
    process.env['JWT_SECRET'] = 'test-secret-include-ownonly'
    const { app, ready } = createRuntime(spec, { enableLogging: false, enableDocs: false })
    await ready

    // Register two users
    const u1 = (await (await app.request('/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123!' }),
    })).json() as { data: { accessToken: string; user: { id: string } } }).data
    const u2 = (await (await app.request('/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'password123!' }),
    })).json() as { data: { accessToken: string; user: { id: string } } }).data

    // u1 creates a catalog
    const cat = await (await app.request('/catalogs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u1.accessToken}` },
      body: JSON.stringify({ name: 'Shared' }),
    })).json() as { data: { id: string } }

    // u1 and u2 both add notes to the catalog
    await app.request('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u1.accessToken}` },
      body: JSON.stringify({ body: 'alice-note', catalogId: cat.data.id }),
    })
    await app.request('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u2.accessToken}` },
      body: JSON.stringify({ body: 'bob-note', catalogId: cat.data.id }),
    })

    // u1 reads the catalog with notes included: must NOT see bob-note
    const res = await app.request(`/catalogs/${cat.data.id}?include=Note`, {
      headers: { Authorization: `Bearer ${u1.accessToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { note: Array<{ body: string; userId: string }> } }
    expect(body.data.note).toBeDefined()
    expect(body.data.note.length).toBe(1)
    expect(body.data.note[0]?.body).toBe('alice-note')
    expect(body.data.note[0]?.userId).toBe(u1.user.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Top-level spec.relations normalisation → Prisma schema + nested endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2.1 — top-level spec.relations is consumed by the generators', () => {
  it('normalizes a top-level many-to-one into a per-resource manyToOne', () => {
    const normalized = normalizeTopLevelRelations({
      version: '1.0', name: 't',
      resources: [
        { name: 'Author', fields: { name: { type: 'string', required: true } } },
        { name: 'Book',   fields: { title: { type: 'string', required: true } } },
      ],
      relations: [
        { from: 'Book', to: 'Author', type: 'many-to-one', field: 'authorId', onDelete: 'cascade' },
      ],
    } as ZeroAPISpec)
    const book = normalized.resources.find((r) => r.name === 'Book')!
    const rel = book.relations?.[0]
    expect(rel?.type).toBe('manyToOne')
    expect(rel?.resource).toBe('Author')
    expect(rel?.field).toBe('authorId')
    expect(rel?.onDelete).toBe('Cascade')
  })

  it('normalizes one-to-many into both oneToMany (source) and manyToOne (target)', () => {
    const normalized = normalizeTopLevelRelations({
      version: '1.0', name: 't',
      resources: [
        { name: 'User',   fields: { email: { type: 'email', required: true } } },
        { name: 'Order',  fields: { total: { type: 'number', required: true } } },
      ],
      relations: [
        { from: 'User', to: 'Order', type: 'one-to-many', field: 'orders', onDelete: 'set-null' },
      ],
    } as ZeroAPISpec)
    const user  = normalized.resources.find((r) => r.name === 'User')!
    const order = normalized.resources.find((r) => r.name === 'Order')!
    expect(user.relations?.[0].type).toBe('oneToMany')
    expect(order.relations?.[0].type).toBe('manyToOne')
    expect(order.relations?.[0].field).toBe('userId')
    expect(order.relations?.[0].onDelete).toBe('SetNull')
  })

  it('normalizes many-to-many through a join table', () => {
    const normalized = normalizeTopLevelRelations({
      version: '1.0', name: 't',
      resources: [
        { name: 'Article',  fields: { title: { type: 'string', required: true } } },
        { name: 'Tag',      fields: { label: { type: 'string', required: true } } },
      ],
      relations: [
        { from: 'Article', to: 'Tag', type: 'many-to-many', field: 'tags', through: 'article_tags' },
      ],
    } as ZeroAPISpec)
    const article = normalized.resources.find((r) => r.name === 'Article')!
    expect(article.relations?.[0].type).toBe('manyToMany')
    expect(article.relations?.[0].through).toBe('article_tags')
  })

  it('parseSpec() produces a Prisma schema with the FK + relation for a top-level many-to-one', () => {
    const spec = parseSpec({
      version: '1.0', name: 'top',
      resources: [
        { name: 'Author', fields: { name: { type: 'string', required: true } } },
        { name: 'Book',   fields: { title: { type: 'string', required: true } } },
      ],
      relations: [
        { from: 'Book', to: 'Author', type: 'many-to-one', field: 'authorId', onDelete: 'cascade' },
      ],
    })
    const schema = generatePrismaSchema(spec)
    expect(schema).toContain('authorId')
    expect(schema).toMatch(/@relation\(fields: \[authorId\], references: \[id\], onDelete: Cascade\)/)
  })

  it('parseSpec() preserves the original spec.relations block alongside per-resource relations', () => {
    const spec = parseSpec({
      version: '1.0', name: 'top',
      resources: [
        { name: 'Author', fields: { name: { type: 'string', required: true } } },
        { name: 'Book',   fields: { title: { type: 'string', required: true } } },
      ],
      relations: [
        { from: 'Book', to: 'Author', type: 'many-to-one', field: 'authorId' },
      ],
    })
    expect(spec.relations).toHaveLength(1)
    expect(spec.resources.find((r) => r.name === 'Book')?.relations).toHaveLength(1)
  })

  it('runtime mounts nested routes from a top-level relations declaration', async () => {
    const spec = parseSpec({
      version: '1.0', name: 'top-runtime',
      resources: [
        { name: 'Author', fields: { name: { type: 'string', required: true } } },
        { name: 'Book',   fields: { title: { type: 'string', required: true } } },
      ],
      relations: [
        { from: 'Book', to: 'Author', type: 'many-to-one', field: 'authorId' },
      ],
    })
    const { app } = createRuntime(spec, { enableLogging: false, enableDocs: false })

    const a = await (await app.request('/authors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Asimov' }),
    })).json() as { data: { id: string } }

    // POST /authors/:id/books forces authorId from URL
    const res = await app.request(`/authors/${a.data.id}/books`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Foundation' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { authorId: string } }
    expect(body.data.authorId).toBe(a.data.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. New parser validations: SetNull on required + FK-field type collision
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2.1 — additional parser validations', () => {
  it('rejects onDelete: SetNull on a required FK', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'bad-setnull',
        resources: [
          { name: 'User',  fields: { name: { type: 'string', required: true } } },
          {
            name: 'Order', fields: { total: { type: 'number', required: true } },
            relations: [
              { type: 'manyToOne', resource: 'User', field: 'userId', required: true, onDelete: 'SetNull' },
            ],
          },
        ],
      })
    ).toThrow(/SetNull on a required FK/)
  })

  it('rejects a relation whose FK reuses a non-string field', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'bad-collision',
        resources: [
          { name: 'User',  fields: { name: { type: 'string', required: true } } },
          {
            name: 'Order',
            fields: {
              total:  { type: 'number',  required: true },
              userId: { type: 'integer', required: true }, // wrong type for an id
            },
            relations: [
              { type: 'manyToOne', resource: 'User', field: 'userId' },
            ],
          },
        ],
      })
    ).toThrow(/FK fields must be string\/uuid/)
  })

  it('allows reusing a uuid field as the FK (common pattern)', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'good-uuid-fk',
        resources: [
          { name: 'Product', fields: { name: { type: 'string', required: true } } },
          {
            name: 'Purchase',
            fields: {
              productId: { type: 'uuid', required: true },
              quantity:  { type: 'integer', required: true, min: 1 },
            },
            relations: [
              { type: 'manyToOne', resource: 'Product', field: 'productId', required: true },
            ],
          },
        ],
      })
    ).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Memory mode: in-process joins match the relational view
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 2.1 — memory mode joins', () => {
  it('many-to-many round trip: create with nested, then include via memory join', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0', name: 'mem-m2m',
      resources: [
        {
          name: 'Category',
          fields: { label: { type: 'string', required: true } },
        },
        {
          name: 'Article',
          fields: { headline: { type: 'string', required: true } },
          relations: [
            {
              type: 'manyToMany', resource: 'Category', through: 'article_categories',
              fields: { position: { type: 'integer' } },
            },
          ],
        },
      ],
    }
    const { app } = createRuntime(spec, { enableLogging: false, enableDocs: false })

    const c1 = await (await app.request('/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Tech' }),
    })).json() as { data: { id: string } }
    const c2 = await (await app.request('/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'News' }),
    })).json() as { data: { id: string } }

    const art = await (await app.request('/articles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        headline: 'Hello',
        categories: [
          { categoryId: c1.data.id, position: 1 },
          { categoryId: c2.data.id, position: 2 },
        ],
      }),
    })).json() as { data: { id: string } }

    const got = await (await app.request(`/articles/${art.data.id}?include=Category`)).json() as {
      data: { category: Array<{ id: string; label: string; position: number }> }
    }
    expect(got.data.category).toHaveLength(2)
    expect(got.data.category.map((c) => c.label).sort()).toEqual(['News', 'Tech'])
    // Extra join-table fields must be merged into the resolved record
    expect(got.data.category.find((c) => c.label === 'Tech')?.position).toBe(1)
  })

  it('one-to-many memory join finds children by their FK on the child', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0', name: 'mem-o2m',
      resources: [
        {
          name: 'Writer',
          fields: { name: { type: 'string', required: true } },
          relations: [{ type: 'oneToMany', resource: 'Novel' }],
        },
        {
          name: 'Novel',
          fields: { title: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Writer', field: 'writerId' }],
        },
      ],
    }
    const { app } = createRuntime(spec, { enableLogging: false, enableDocs: false })

    const w = await (await app.request('/writers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Le Guin' }),
    })).json() as { data: { id: string } }

    await app.request('/novels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'The Dispossessed', writerId: w.data.id }),
    })
    await app.request('/novels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Left Hand', writerId: w.data.id }),
    })

    const got = await (await app.request(`/writers/${w.data.id}?include=Novel`)).json() as {
      data: { novel: Array<{ title: string }> }
    }
    expect(got.data.novel).toHaveLength(2)
  })
})
