import { afterEach, describe, it, expect } from 'vitest'
import type { Hono } from 'hono'
import {
  createRuntime,
  parseSpec,
  ParseError,
  generatePrismaSchema,
  generateApiKey,
  MemoryApiKeyStore,
  MemoryUserStore,
  MemoryRefreshTokenStore,
} from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const SAVED_JWT_SECRET = process.env['JWT_SECRET']
const SAVED_NODE_ENV = process.env['NODE_ENV']

afterEach(() => {
  if (SAVED_JWT_SECRET === undefined) delete process.env['JWT_SECRET']
  else process.env['JWT_SECRET'] = SAVED_JWT_SECRET
  if (SAVED_NODE_ENV === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = SAVED_NODE_ENV
})

const opts = {
  enableLogging: false,
  enableDocs: false,
  enableHelmet: false,
  enableCors: false,
  enableSanitize: false,
  jwtSecretLogger: () => { /* silent */ },
  apiKeyBootstrapLogger: () => { /* silent */ },
}

function jwtBaseSpec(overrides: Partial<ZeroAPISpec> = {}): ZeroAPISpec {
  return {
    version: '1.0.0',
    name: 'phase-1-3-rbac',
    auth: {
      enabled: true,
      strategies: ['jwt'],
      jwt: { enabled: true, secretEnv: 'JWT_SECRET' },
    },
    resources: [
      {
        name: 'Product',
        fields: { title: { type: 'string', required: true } },
      },
    ],
    permissions: [
      {
        resource: 'Product',
        rules: [
          { role: 'public', actions: ['read'] },
          { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
          { role: 'vendor', actions: ['create', 'read', 'update'], ownOnly: true },
        ],
      },
    ],
    ...overrides,
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

async function jsonReq(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function registerAndLogin(
  app: Hono,
  email: string,
  password: string,
): Promise<{ accessToken: string; userId: string }> {
  const reg = await readJson<{
    data: { user: { id: string }; accessToken: string }
  }>(await jsonReq(app, 'POST', '/auth/register', { email, password }))
  return { accessToken: reg.data.accessToken, userId: reg.data.user.id }
}

async function bootstrapUserWithRole(
  userStore: MemoryUserStore,
  email: string,
  role: string,
): Promise<string> {
  const u = await userStore.create({
    email,
    passwordHash: 'irrelevant',
    salt: 'irrelevant',
    role,
  })
  return u.id
}

function makeRuntimeWithUsers(spec: ZeroAPISpec) {
  process.env['JWT_SECRET'] = 'phase-1-3-secret'
  const userStore = new MemoryUserStore()
  const refreshTokenStore = new MemoryRefreshTokenStore()
  const rt = createRuntime(spec, { ...opts, userStore, refreshTokenStore })
  return { ...rt, userStore, refreshTokenStore }
}

// ── Parser validation ───────────────────────────────────────────────────────

describe('parser — ownOnly rules', () => {
  it('rejects ownOnly when auth.jwt is not enabled', () => {
    expect(() => parseSpec({
      version: '1.0', name: 'api',
      auth: { strategy: 'bearer' },
      resources: [{ name: 'Item', fields: { name: { type: 'string', required: true } } }],
      permissions: [
        { resource: 'Item', rules: [{ role: 'user', actions: ['read'], ownOnly: true }] },
      ],
    })).toThrow(/ownOnly.*auth\.jwt/i)
  })

  it('rejects ownOnly with the "public" role', () => {
    expect(() => parseSpec({
      version: '1.0', name: 'api',
      auth: { jwt: { enabled: true } },
      resources: [{ name: 'Item', fields: { name: { type: 'string', required: true } } }],
      permissions: [
        { resource: 'Item', rules: [{ role: 'public', actions: ['read'], ownOnly: true }] },
      ],
    })).toThrow(ParseError)
  })

  it('accepts ownOnly when auth.jwt.enabled is true', () => {
    const spec = parseSpec({
      version: '1.0', name: 'api',
      auth: { jwt: { enabled: true } },
      resources: [{ name: 'Item', fields: { name: { type: 'string', required: true } } }],
      permissions: [
        { resource: 'Item', rules: [{ role: 'vendor', actions: ['read'], ownOnly: true }] },
      ],
    })
    expect(spec.permissions?.[0].rules[0].ownOnly).toBe(true)
  })
})

// ── No auth → all endpoints public (backwards compat) ───────────────────────

describe('no auth in spec → endpoints stay public', () => {
  it('GET /products works without a token when no auth is configured', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'public-api',
      resources: [{ name: 'Product', fields: { title: { type: 'string', required: true } } }],
    }
    const { app } = createRuntime(spec, opts)
    const res = await app.request('/products')
    expect(res.status).toBe(200)
  })
})

// ── public rule lets unauthenticated requests through ───────────────────────

describe('public permission rule', () => {
  it('allows unauthenticated GET when "public" can read', async () => {
    const { app } = makeRuntimeWithUsers(jwtBaseSpec())
    const res = await app.request('/products')
    expect(res.status).toBe(200)
  })

  it('blocks unauthenticated writes even when public can read', async () => {
    const { app } = makeRuntimeWithUsers(jwtBaseSpec())
    const res = await jsonReq(app, 'POST', '/products', { title: 'X' })
    expect(res.status).toBe(401)
  })
})

// ── admin role: full access ─────────────────────────────────────────────────

describe('admin role', () => {
  it('can create, read, update and delete', async () => {
    const { app, userStore } = makeRuntimeWithUsers(jwtBaseSpec())
    await bootstrapUserWithRole(userStore, 'admin@example.com', 'admin')

    // Generate a JWT for admin manually via /auth/register isn't possible (default role is 'user'),
    // so we use a manually crafted JWT signed with the spec secret.
    const { generateAccessToken } = await import('../../src/auth/jwt.js')
    const adminToken = await generateAccessToken(
      'admin-id', 'admin@example.com', 'admin', 'phase-1-3-secret', 3600,
    )
    const auth = { Authorization: `Bearer ${adminToken}` }

    const created = await jsonReq(app, 'POST', '/products', { title: 'Phone' }, auth)
    expect(created.status).toBe(201)
    const { data } = await readJson<{ data: { id: string } }>(created)

    const got = await app.request(`/products/${data.id}`, { headers: auth })
    expect(got.status).toBe(200)

    const upd = await jsonReq(app, 'PUT', `/products/${data.id}`, { title: 'Phone Pro' }, auth)
    expect(upd.status).toBe(200)

    const del = await app.request(`/products/${data.id}`, { method: 'DELETE', headers: auth })
    expect(del.status).toBe(200)
  })
})

// ── ownOnly: vendor sees only their own rows ────────────────────────────────

describe('ownOnly — vendor scoping', () => {
  async function tokenForRole(userId: string, email: string, role: string): Promise<string> {
    const { generateAccessToken } = await import('../../src/auth/jwt.js')
    return generateAccessToken(userId, email, role, 'phase-1-3-secret', 3600)
  }

  it('LIST only returns the vendor\'s own products', async () => {
    const { app, userStore } = makeRuntimeWithUsers(jwtBaseSpec())
    const vendorA = await bootstrapUserWithRole(userStore, 'a@x.com', 'vendor')
    const vendorB = await bootstrapUserWithRole(userStore, 'b@x.com', 'vendor')

    const tokenA = await tokenForRole(vendorA, 'a@x.com', 'vendor')
    const tokenB = await tokenForRole(vendorB, 'b@x.com', 'vendor')

    await jsonReq(app, 'POST', '/products', { title: 'A1' }, { Authorization: `Bearer ${tokenA}` })
    await jsonReq(app, 'POST', '/products', { title: 'A2' }, { Authorization: `Bearer ${tokenA}` })
    await jsonReq(app, 'POST', '/products', { title: 'B1' }, { Authorization: `Bearer ${tokenB}` })

    const listA = await readJson<{ data: Array<{ title: string }> }>(
      await app.request('/products', { headers: { Authorization: `Bearer ${tokenA}` } }),
    )
    expect(listA.data.map((p) => p.title).sort()).toEqual(['A1', 'A2'])

    const listB = await readJson<{ data: Array<{ title: string }> }>(
      await app.request('/products', { headers: { Authorization: `Bearer ${tokenB}` } }),
    )
    expect(listB.data.map((p) => p.title)).toEqual(['B1'])
  })

  it('CREATE forces userId from the JWT, even when the body supplies one', async () => {
    const { app, userStore } = makeRuntimeWithUsers(jwtBaseSpec())
    const vendorA = await bootstrapUserWithRole(userStore, 'a@x.com', 'vendor')
    const vendorB = await bootstrapUserWithRole(userStore, 'b@x.com', 'vendor')

    const tokenA = await tokenForRole(vendorA, 'a@x.com', 'vendor')

    const res = await jsonReq(
      app, 'POST', '/products',
      { title: 'attempted-steal', userId: vendorB },
      { Authorization: `Bearer ${tokenA}` },
    )
    expect(res.status).toBe(201)
    const { data } = await readJson<{ data: { userId: string } }>(res)
    expect(data.userId).toBe(vendorA)
  })

  it('READ on another vendor\'s product returns 404 (not 403)', async () => {
    const { app, userStore } = makeRuntimeWithUsers(jwtBaseSpec())
    const vendorA = await bootstrapUserWithRole(userStore, 'a@x.com', 'vendor')
    const vendorB = await bootstrapUserWithRole(userStore, 'b@x.com', 'vendor')

    const tokenA = await tokenForRole(vendorA, 'a@x.com', 'vendor')
    const tokenB = await tokenForRole(vendorB, 'b@x.com', 'vendor')

    const created = await readJson<{ data: { id: string } }>(
      await jsonReq(app, 'POST', '/products', { title: 'A-only' },
        { Authorization: `Bearer ${tokenA}` }),
    )

    const res = await app.request(`/products/${created.data.id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    expect(res.status).toBe(404)
  })

  it('UPDATE on another vendor\'s product returns 404', async () => {
    const { app, userStore } = makeRuntimeWithUsers(jwtBaseSpec())
    const vendorA = await bootstrapUserWithRole(userStore, 'a@x.com', 'vendor')
    const vendorB = await bootstrapUserWithRole(userStore, 'b@x.com', 'vendor')

    const tokenA = await tokenForRole(vendorA, 'a@x.com', 'vendor')
    const tokenB = await tokenForRole(vendorB, 'b@x.com', 'vendor')

    const created = await readJson<{ data: { id: string } }>(
      await jsonReq(app, 'POST', '/products', { title: 'A-only' },
        { Authorization: `Bearer ${tokenA}` }),
    )

    const res = await jsonReq(
      app, 'PUT', `/products/${created.data.id}`, { title: 'hacked' },
      { Authorization: `Bearer ${tokenB}` },
    )
    expect(res.status).toBe(404)

    // And the row is unchanged
    const getRes = await app.request(`/products/${created.data.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    const got = await readJson<{ data: { title: string; userId: string } }>(getRes)
    expect(got.data.title).toBe('A-only')
    expect(got.data.userId).toBe(vendorA)
  })

  it('UPDATE cannot transfer ownership via a body field', async () => {
    const { app, userStore } = makeRuntimeWithUsers(jwtBaseSpec())
    const vendorA = await bootstrapUserWithRole(userStore, 'a@x.com', 'vendor')
    const vendorB = await bootstrapUserWithRole(userStore, 'b@x.com', 'vendor')

    const tokenA = await tokenForRole(vendorA, 'a@x.com', 'vendor')

    const created = await readJson<{ data: { id: string } }>(
      await jsonReq(app, 'POST', '/products', { title: 'Mine' },
        { Authorization: `Bearer ${tokenA}` }),
    )

    const upd = await jsonReq(
      app, 'PUT', `/products/${created.data.id}`,
      { title: 'Mine renamed', userId: vendorB },
      { Authorization: `Bearer ${tokenA}` },
    )
    expect(upd.status).toBe(200)

    const got = await readJson<{ data: { userId: string } }>(
      await app.request(`/products/${created.data.id}`,
        { headers: { Authorization: `Bearer ${tokenA}` } }),
    )
    expect(got.data.userId).toBe(vendorA)
  })

  it('vendor cannot delete (no delete in vendor rule) — even own rows', async () => {
    const { app, userStore } = makeRuntimeWithUsers(jwtBaseSpec())
    const vendorA = await bootstrapUserWithRole(userStore, 'a@x.com', 'vendor')
    const tokenA = await tokenForRole(vendorA, 'a@x.com', 'vendor')

    const created = await readJson<{ data: { id: string } }>(
      await jsonReq(app, 'POST', '/products', { title: 'Mine' },
        { Authorization: `Bearer ${tokenA}` }),
    )

    const res = await app.request(`/products/${created.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    expect(res.status).toBe(403)
  })
})

// ── Fail-closed: auth on, resource without rule ─────────────────────────────

describe('fail-closed default', () => {
  it('a resource not covered by permissions requires auth (401 without token)', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'closed-api',
      auth: { jwt: { enabled: true }, strategies: ['jwt'] },
      resources: [
        { name: 'Product', fields: { title: { type: 'string', required: true } } },
        { name: 'Secret', fields: { value: { type: 'string', required: true } } },
      ],
      permissions: [
        { resource: 'Product', rules: [{ role: 'public', actions: ['read'] }] },
      ],
    }
    const { app } = makeRuntimeWithUsers(spec)
    const res = await app.request('/secrets')
    expect(res.status).toBe(401)

    // And the covered resource still allows public read
    const pub = await app.request('/products')
    expect(pub.status).toBe(200)
  })

  it('any authenticated user can access an uncovered resource (no role check)', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'closed-api',
      auth: { jwt: { enabled: true }, strategies: ['jwt'] },
      resources: [
        { name: 'Secret', fields: { value: { type: 'string', required: true } } },
      ],
      permissions: [], // empty array → not "no permissions block"
    }
    // Empty array means no rules → not the same as "no permissions block".
    // Currently we treat empty array the same as missing → so verify the spec
    // with a covered-elsewhere block instead.
    const filledSpec: ZeroAPISpec = {
      ...spec,
      resources: [
        ...spec.resources,
        { name: 'Decoy', fields: { x: { type: 'string', required: true } } },
      ],
      permissions: [
        { resource: 'Decoy', rules: [{ role: 'admin', actions: ['read'] }] },
      ],
    }

    const { app } = makeRuntimeWithUsers(filledSpec)
    const { generateAccessToken } = await import('../../src/auth/jwt.js')
    const token = await generateAccessToken('u1', 'u@x.com', 'user', 'phase-1-3-secret', 3600)

    const res = await app.request('/secrets', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})

// ── Role denial ─────────────────────────────────────────────────────────────

describe('role denial', () => {
  it('a non-matching role gets 403 even with a valid token', async () => {
    const { app, userStore } = makeRuntimeWithUsers(jwtBaseSpec())
    const visitor = await bootstrapUserWithRole(userStore, 'v@x.com', 'visitor')
    const { generateAccessToken } = await import('../../src/auth/jwt.js')
    const token = await generateAccessToken(visitor, 'v@x.com', 'visitor', 'phase-1-3-secret', 3600)

    const res = await jsonReq(app, 'POST', '/products', { title: 'X' },
      { Authorization: `Bearer ${token}` })
    expect(res.status).toBe(403)
  })
})

// ── API keys carry a role used for RBAC ─────────────────────────────────────

describe('API key roles', () => {
  it('an API key with role admin gets full access', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'apikey-rbac',
      auth: {
        enabled: true,
        strategies: ['apikey'],
        apikey: { enabled: true, header: 'x-api-key', prefix: 'zak_live_' },
      },
      resources: [
        { name: 'Product', fields: { title: { type: 'string', required: true } } },
      ],
      permissions: [
        {
          resource: 'Product',
          rules: [
            { role: 'public', actions: ['read'] },
            { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
          ],
        },
      ],
    }

    const apiKeyStore = new MemoryApiKeyStore()
    const seeded = generateApiKey()
    await apiKeyStore.create({
      keyHash: seeded.keyHash,
      keyPrefix: seeded.keyPrefix,
      name: 'svc',
      role: 'admin',
    })

    const { app } = createRuntime(spec, { ...opts, apiKeyStore })
    const auth = { 'x-api-key': seeded.key }

    const created = await jsonReq(app, 'POST', '/products', { title: 'P' }, auth)
    expect(created.status).toBe(201)
    const { data } = await readJson<{ data: { id: string } }>(created)

    const del = await app.request(`/products/${data.id}`, { method: 'DELETE', headers: auth })
    expect(del.status).toBe(200)
  })

  it('an API key with a non-matching role is forbidden', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'apikey-rbac',
      auth: {
        enabled: true,
        strategies: ['apikey'],
        apikey: { enabled: true, header: 'x-api-key', prefix: 'zak_live_' },
      },
      resources: [
        { name: 'Product', fields: { title: { type: 'string', required: true } } },
      ],
      permissions: [
        {
          resource: 'Product',
          rules: [
            { role: 'public', actions: ['read'] },
            { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
          ],
        },
      ],
    }

    const apiKeyStore = new MemoryApiKeyStore()
    const seeded = generateApiKey()
    await apiKeyStore.create({
      keyHash: seeded.keyHash,
      keyPrefix: seeded.keyPrefix,
      name: 'limited',
      role: 'reader',
    })

    const { app } = createRuntime(spec, { ...opts, apiKeyStore })
    const res = await jsonReq(app, 'POST', '/products', { title: 'P' },
      { 'x-api-key': seeded.key })
    expect(res.status).toBe(403)
  })

  it('the bootstrapped API key defaults to role "admin"', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'apikey-default-role',
      auth: {
        enabled: true,
        strategies: ['apikey'],
        apikey: { enabled: true, header: 'x-api-key', prefix: 'zak_live_' },
      },
      resources: [
        { name: 'Product', fields: { title: { type: 'string', required: true } } },
      ],
    }

    const apiKeyStore = new MemoryApiKeyStore()
    createRuntime(spec, { ...opts, apiKeyStore })

    const records = await apiKeyStore.list()
    expect(records).toHaveLength(1)
    expect(records[0]!.role).toBe('admin')
  })
})

// ── Generated Prisma schema includes userId + relation ──────────────────────

describe('Prisma schema — ownOnly side effects', () => {
  it('adds userId field + User relation when a resource has an ownOnly rule', () => {
    const schema = generatePrismaSchema(jwtBaseSpec())
    expect(schema).toMatch(/model Product \{[\s\S]*userId\s+String[\s\S]*\}/)
    expect(schema).toContain('user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)')
    expect(schema).toContain('ownedProducts Product[]')
  })

  it('emits role column on ApiKey model', () => {
    const schema = generatePrismaSchema({
      version: '1.0', name: 'x',
      auth: { strategy: 'apikey' },
      resources: [{ name: 'Item', fields: { name: { type: 'string', required: true } } }],
    })
    expect(schema).toContain('role       String    @default("admin")')
  })

  it('does not add userId to the resource model when no ownOnly rule exists', () => {
    const schema = generatePrismaSchema({
      version: '1.0',
      name: 'no-own',
      auth: { jwt: { enabled: true } },
      resources: [{ name: 'Item', fields: { name: { type: 'string', required: true } } }],
      permissions: [
        { resource: 'Item', rules: [{ role: 'admin', actions: ['read'] }] },
      ],
    })
    const itemBlock = schema.match(/model Item \{[\s\S]*?\}/)?.[0] ?? ''
    expect(itemBlock).not.toMatch(/userId/)
    expect(schema).not.toContain('ownedItems')
  })
})

// ── /auth/register-issued tokens flow through RBAC ──────────────────────────

describe('JWT register → /auth/me → permission flow', () => {
  it('a freshly registered user (role "user") is denied write on Product', async () => {
    const { app } = makeRuntimeWithUsers(jwtBaseSpec())
    const { accessToken } = await registerAndLogin(app, 'u@example.com', 'mypassword')

    const res = await jsonReq(app, 'POST', '/products', { title: 'X' },
      { Authorization: `Bearer ${accessToken}` })
    expect(res.status).toBe(403)
  })
})
