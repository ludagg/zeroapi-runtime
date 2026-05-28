import { afterEach, describe, it, expect } from 'vitest'
import {
  createRuntime,
  parseSpec,
  ParseError,
  generatePrismaSchema,
  cascadeSystemResourceDelete,
  projectSystemResource,
} from '../../src/index.js'
import type { ZeroAPISpec, DataStore } from '../../src/index.js'

const SAVED_JWT_SECRET = process.env['JWT_SECRET']

function restoreEnv(): void {
  if (SAVED_JWT_SECRET === undefined) delete process.env['JWT_SECRET']
  else process.env['JWT_SECRET'] = SAVED_JWT_SECRET
}
afterEach(() => { restoreEnv() })

const opts = {
  enableLogging: false,
  enableDocs: false,
  enableHelmet: false,
  enableCors: false,
  enableSanitize: false,
}

function makeSpecWithUserRel(overrides: Partial<ZeroAPISpec> = {}): ZeroAPISpec {
  return {
    version: '1.0.0',
    name: 'system-rel-test',
    auth: { jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
    resources: [
      {
        name: 'Order',
        fields: { total: { type: 'number', required: true } },
        relations: [
          { type: 'manyToOne', resource: 'User', field: 'userId', required: true, onDelete: 'Cascade' },
        ],
      },
    ],
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Parser — relation to User is allowed only when auth.jwt is enabled
// ─────────────────────────────────────────────────────────────────────────────

describe('System resources — parser', () => {
  it('accepts a relation to "User" when auth.jwt.enabled is true', () => {
    expect(() => parseSpec(makeSpecWithUserRel())).not.toThrow()
  })

  it('rejects a relation to "User" when auth.jwt is not enabled', () => {
    expect(() =>
      parseSpec({
        version: '1.0.0',
        name: 'no-jwt',
        resources: [
          {
            name: 'Order',
            fields: { total: { type: 'number', required: true } },
            relations: [{ type: 'manyToOne', resource: 'User', field: 'userId' }],
          },
        ],
      }),
    ).toThrow(ParseError)
  })

  it('rejects a manyToMany relation to "User" (unsupported direction)', () => {
    expect(() =>
      parseSpec({
        version: '1.0.0',
        name: 'bad-direction',
        auth: { jwt: { enabled: true } },
        resources: [
          { name: 'Tag', fields: { label: { type: 'string', required: true } } },
          {
            name: 'Post',
            fields: { title: { type: 'string', required: true } },
            relations: [{ type: 'manyToMany', resource: 'User', through: 'user_posts' }],
          },
        ],
      }),
    ).toThrow(/only manyToOne or oneToOne/i)
  })

  it('keeps the "User" name reserved as a user-defined resource when jwt is on', () => {
    expect(() =>
      parseSpec({
        version: '1.0.0', name: 'collide',
        auth: { jwt: { enabled: true } },
        resources: [{ name: 'User', fields: { name: { type: 'string', required: true } } }],
      }),
    ).toThrow(/reserved/i)
  })

  it('accepts top-level relation to "User" when auth.jwt.enabled', () => {
    expect(() =>
      parseSpec({
        version: '1.0.0',
        name: 'top-level-user-rel',
        auth: { jwt: { enabled: true } },
        resources: [
          { name: 'Order', fields: { total: { type: 'number', required: true } } },
        ],
        relations: [
          { from: 'Order', to: 'User', type: 'many-to-one', field: 'userId', onDelete: 'cascade' },
        ],
      }),
    ).not.toThrow()
  })

  it('rejects top-level relation to "User" when auth.jwt is off', () => {
    expect(() =>
      parseSpec({
        version: '1.0.0',
        name: 'top-level-no-jwt',
        resources: [
          { name: 'Order', fields: { total: { type: 'number', required: true } } },
        ],
        relations: [
          { from: 'Order', to: 'User', type: 'many-to-one', field: 'userId' },
        ],
      }),
    ).toThrow(/auth feature is not enabled/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Prisma schema — FK on Order, back-relation on User
// ─────────────────────────────────────────────────────────────────────────────

describe('System resources — Prisma schema', () => {
  it('emits userId + user @relation on Order', () => {
    const schema = generatePrismaSchema(parseSpec(makeSpecWithUserRel()))
    expect(schema).toContain('model Order {')
    expect(schema).toMatch(/userId\s+String/)
    expect(schema).toMatch(/user\s+User\s+@relation\(fields: \[userId\], references: \[id\]/)
  })

  it('honours onDelete: Cascade on the FK', () => {
    const schema = generatePrismaSchema(parseSpec(makeSpecWithUserRel()))
    expect(schema).toMatch(/references: \[id\], onDelete: Cascade/)
  })

  it('adds the back-relation User.orders[]', () => {
    const schema = generatePrismaSchema(parseSpec(makeSpecWithUserRel()))
    expect(schema).toContain('model User {')
    expect(schema).toMatch(/orders\s+Order\[\]/)
  })

  it('does not double-inject ownerOnly userId column when the explicit relation already declares it', () => {
    const spec = parseSpec({
      version: '1.0.0',
      name: 'explicit+ownonly',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Order',
          fields: { total: { type: 'number', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'userId', required: true, onDelete: 'Cascade' },
          ],
        },
      ],
      permissions: [
        { resource: 'Order', rules: [{ role: 'user', actions: ['create', 'read'], ownOnly: true }] },
      ],
    })
    const schema = generatePrismaSchema(spec)
    // Exactly one `userId String` line on Order (not two)
    const orderModel = schema.slice(schema.indexOf('model Order {'), schema.indexOf('}', schema.indexOf('model Order {')))
    const userIdMatches = orderModel.match(/userId\s+String/g) ?? []
    expect(userIdMatches.length).toBe(1)
    const userRelMatches = orderModel.match(/user\s+User\s+@relation/g) ?? []
    expect(userRelMatches.length).toBe(1)
  })

  it('User.orders is emitted once even when the resource is also ownOnly', () => {
    const spec = parseSpec({
      version: '1.0.0',
      name: 'ownonly+explicit',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Order',
          fields: { total: { type: 'number', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'userId', required: true, onDelete: 'Cascade' },
          ],
        },
      ],
      permissions: [
        { resource: 'Order', rules: [{ role: 'user', actions: ['create', 'read'], ownOnly: true }] },
      ],
    })
    const schema = generatePrismaSchema(spec)
    const userModel = schema.slice(schema.indexOf('model User {'), schema.indexOf('}', schema.indexOf('model User {')))
    const orderBacks = userModel.match(/Order\[\]/g) ?? []
    expect(orderBacks.length).toBe(1)
  })

  it('falls back to ownedOrders[] when only ownOnly is set (no explicit relation)', () => {
    const spec = parseSpec({
      version: '1.0.0',
      name: 'ownonly-only',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Order',
          fields: { total: { type: 'number', required: true } },
        },
      ],
      permissions: [
        { resource: 'Order', rules: [{ role: 'user', actions: ['create', 'read'], ownOnly: true }] },
      ],
    })
    const schema = generatePrismaSchema(spec)
    expect(schema).toMatch(/ownedOrders\s+Order\[\]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. ?include=user resolves the safe user fields only
// ─────────────────────────────────────────────────────────────────────────────

describe('System resources — ?include=user safe projection', () => {
  it('loads the related user when ?include=user is supplied, without sensitive fields', async () => {
    process.env['JWT_SECRET'] = 'incl-user-' + Math.random().toString(36).slice(2)
    const { app } = createRuntime(parseSpec(makeSpecWithUserRel()), { ...opts, jwtSecretLogger: () => {} })

    const reg = await (await app.request('/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    })).json() as { data: { user: { id: string }; accessToken: string } }

    const created = await (await app.request('/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 99, userId: reg.data.user.id }),
    })).json() as { data: { id: string; userId: string } }

    expect(created.data.userId).toBe(reg.data.user.id)

    const listed = await (await app.request('/orders?include=user')).json() as {
      data: Array<{ user: Record<string, unknown> }>
    }
    const user = listed.data[0]?.user
    expect(user).toBeDefined()
    expect(user!['id']).toBe(reg.data.user.id)
    expect(user!['email']).toBe('alice@example.com')
    expect(user!['role']).toBe('user')
    // ── Sensitive fields must never leak through ?include ────────────────────
    expect('passwordHash' in user!).toBe(false)
    expect('salt' in user!).toBe(false)
    expect('refreshTokens' in user!).toBe(false)
  })

  it('?include=user on GET /orders/:id also strips sensitive fields', async () => {
    process.env['JWT_SECRET'] = 'single-incl-' + Math.random().toString(36).slice(2)
    const { app } = createRuntime(parseSpec(makeSpecWithUserRel()), { ...opts, jwtSecretLogger: () => {} })

    const reg = await (await app.request('/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'password123' }),
    })).json() as { data: { user: { id: string } } }

    const created = await (await app.request('/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 10, userId: reg.data.user.id }),
    })).json() as { data: { id: string } }

    const single = await (await app.request(`/orders/${created.data.id}?include=user`)).json() as {
      data: { user: Record<string, unknown> }
    }
    expect(single.data.user['email']).toBe('bob@example.com')
    expect('passwordHash' in single.data.user).toBe(false)
    expect('salt' in single.data.user).toBe(false)
  })

  it('?include=user returns null when the FK does not match any user', async () => {
    process.env['JWT_SECRET'] = 'orphan-' + Math.random().toString(36).slice(2)
    const spec = parseSpec({
      version: '1.0.0',
      name: 'optional-user-rel',
      auth: { jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
      resources: [
        {
          name: 'Note',
          fields: { body: { type: 'string', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'userId', required: false },
          ],
        },
      ],
    })
    const { app } = createRuntime(spec, { ...opts, jwtSecretLogger: () => {} })

    // Create a note WITHOUT a userId (no auth required, optional FK)
    const created = await (await app.request('/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'orphan note' }),
    })).json() as { data: { id: string } }

    const fetched = await (await app.request(`/notes/${created.data.id}?include=user`)).json() as {
      data: { user: unknown }
    }
    expect(fetched.data.user).toBeNull()
  })

  it('?include=user with an unknown user id resolves to null (not an error)', async () => {
    process.env['JWT_SECRET'] = 'missing-' + Math.random().toString(36).slice(2)
    const spec = parseSpec({
      version: '1.0.0',
      name: 'missing-user',
      auth: { jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
      resources: [
        {
          name: 'Note',
          fields: { body: { type: 'string', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'userId', required: false },
          ],
        },
      ],
    })
    const { app } = createRuntime(spec, { ...opts, jwtSecretLogger: () => {} })

    const created = await (await app.request('/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'ghost owner', userId: 'does-not-exist' }),
    })).json() as { data: { id: string } }

    const fetched = await (await app.request(`/notes/${created.data.id}?include=user`)).json() as {
      data: { user: unknown }
    }
    expect(fetched.data.user).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cascade delete user → cascades to owned orders
// ─────────────────────────────────────────────────────────────────────────────

describe('System resources — onDelete cascade', () => {
  it('cascadeSystemResourceDelete removes child rows with onDelete: Cascade', async () => {
    process.env['JWT_SECRET'] = 'cascade-' + Math.random().toString(36).slice(2)
    const runtime = createRuntime(parseSpec(makeSpecWithUserRel()), { ...opts, jwtSecretLogger: () => {} })

    const reg = await (await runtime.app.request('/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cas@example.com', password: 'password123' }),
    })).json() as { data: { user: { id: string } } }

    await runtime.app.request('/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 1, userId: reg.data.user.id }),
    })
    await runtime.app.request('/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: 2, userId: reg.data.user.id }),
    })

    const before = await (await runtime.app.request('/orders')).json() as { count: number }
    expect(before.count).toBe(2)

    // Cascade through the runtime helper
    const result = await runtime.deleteSystemResource!('User', reg.data.user.id)
    expect(result.deleted['Order']?.length).toBe(2)

    const after = await (await runtime.app.request('/orders')).json() as { count: number }
    expect(after.count).toBe(0)
  })

  it('SetNull clears the child FK instead of deleting the row', () => {
    const spec = parseSpec({
      version: '1.0.0',
      name: 'setnull',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Post',
          fields: { title: { type: 'string', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'userId', onDelete: 'SetNull' },
          ],
        },
      ],
    })
    const store: DataStore = new Map()
    store.set('post', new Map([
      ['p1', { id: 'p1', title: 'one', userId: 'u1' }],
      ['p2', { id: 'p2', title: 'two', userId: 'u2' }],
    ]))

    const result = cascadeSystemResourceDelete(spec, store, 'User', 'u1')
    expect(result.setNull['Post']).toEqual(['p1'])
    expect(store.get('post')!.get('p1')!['userId']).toBeNull()
    expect(store.get('post')!.get('p2')!['userId']).toBe('u2')
  })

  it('Restrict throws when child rows still reference the user (and rolls back nothing)', () => {
    const spec = parseSpec({
      version: '1.0.0',
      name: 'restrict',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Invoice',
          fields: { total: { type: 'number', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'userId', onDelete: 'Restrict' },
          ],
        },
      ],
    })
    const store: DataStore = new Map()
    store.set('invoice', new Map([
      ['i1', { id: 'i1', total: 50, userId: 'u1' }],
    ]))

    expect(() => cascadeSystemResourceDelete(spec, store, 'User', 'u1')).toThrow(/Restrict/i)
    // Untouched
    expect(store.get('invoice')!.get('i1')!['userId']).toBe('u1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Safe projection helper
// ─────────────────────────────────────────────────────────────────────────────

describe('projectSystemResource', () => {
  it('drops passwordHash, salt and any field not in the safe list', () => {
    const row = projectSystemResource('User', {
      id: 'u1', email: 'a@b.c', role: 'user', emailVerified: true,
      passwordHash: 'secret', salt: 'salt',
      refreshTokens: ['rt1'], extra: 'leak',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    })
    expect(row).toEqual({
      id: 'u1', email: 'a@b.c', role: 'user', emailVerified: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    })
  })

  it('returns null for null / undefined input', () => {
    expect(projectSystemResource('User', null)).toBeNull()
    expect(projectSystemResource('User', undefined)).toBeNull()
  })
})
