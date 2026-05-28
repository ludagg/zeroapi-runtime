import { afterEach, describe, it, expect } from 'vitest'
import {
  createRuntime,
  parseSpec,
  generatePrismaSchema,
  generateAccessToken,
  hashRefreshToken,
  parseTTL,
  resolveJwtSecret,
  MemoryUserStore,
  MemoryRefreshTokenStore,
  PrismaUserStore,
  PrismaRefreshTokenStore,
} from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'
import type {
  PrismaUserLikeClient, PrismaUserRow,
} from '../../src/auth/prisma-user-store.js'
import type {
  PrismaRefreshTokenLikeClient, PrismaRefreshTokenRow,
} from '../../src/auth/prisma-refresh-token-store.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<ZeroAPISpec> = {}): ZeroAPISpec {
  return {
    version: '1.0.0',
    name: 'jwt-test',
    auth: {
      enabled: true,
      strategies: ['jwt'],
      jwt: {
        enabled: true,
        accessTokenTTL: '15m',
        refreshTokenTTL: '7d',
        secretEnv: 'JWT_SECRET',
      },
    },
    resources: [
      {
        name: 'Widget',
        fields: { label: { type: 'string', required: true } },
      },
    ],
    ...overrides,
  }
}

const opts = {
  enableLogging: false,
  enableDocs: false,
  enableHelmet: false,
  enableCors: false,
  enableSanitize: false,
}

const SAVED_ENV = {
  NODE_ENV: process.env['NODE_ENV'],
  JWT_SECRET: process.env['JWT_SECRET'],
}

function restoreEnv(): void {
  if (SAVED_ENV.NODE_ENV === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = SAVED_ENV.NODE_ENV
  if (SAVED_ENV.JWT_SECRET === undefined) delete process.env['JWT_SECRET']
  else process.env['JWT_SECRET'] = SAVED_ENV.JWT_SECRET
}

function makeRuntime(spec = makeSpec()) {
  process.env['JWT_SECRET'] = 'test-secret-' + Math.random().toString(36).slice(2)
  const lines: string[] = []
  const rt = createRuntime(spec, {
    ...opts,
    jwtSecretLogger: (l) => lines.push(l),
  })
  return { ...rt, lines }
}

async function jsonReq(
  app: ReturnType<typeof makeRuntime>['app'],
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

async function readJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

afterEach(() => { restoreEnv() })

// ── Register ─────────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('creates a user, returns access + refresh tokens, never exposes passwordHash', async () => {
    const { app } = makeRuntime()
    const res = await jsonReq(app, 'POST', '/auth/register', {
      email: 'alice@example.com', password: 'supersecret',
    })
    expect(res.status).toBe(201)
    const { data } = await readJson<{
      data: {
        user: { id: string; email: string; role: string; emailVerified: boolean }
        accessToken: string
        refreshToken: string
      }
    }>(res)
    expect(data.user.email).toBe('alice@example.com')
    expect(data.user.role).toBe('user')
    expect(data.user.emailVerified).toBe(false)
    expect(typeof data.user.id).toBe('string')
    expect(data.accessToken.split('.').length).toBe(3)
    expect(data.refreshToken.length).toBeGreaterThan(40)

    const userPayload = data.user as Record<string, unknown>
    expect('passwordHash' in userPayload).toBe(false)
    expect('salt' in userPayload).toBe(false)
  })

  it('rejects a second registration with the same email (409)', async () => {
    const { app } = makeRuntime()
    await jsonReq(app, 'POST', '/auth/register', { email: 'bob@example.com', password: 'password' })
    const second = await jsonReq(app, 'POST', '/auth/register', {
      email: 'bob@example.com', password: 'different',
    })
    expect(second.status).toBe(409)
  })

  it('rejects an invalid email (400)', async () => {
    const { app } = makeRuntime()
    const res = await jsonReq(app, 'POST', '/auth/register', { email: 'nope', password: 'password' })
    expect(res.status).toBe(400)
  })

  it('rejects a short password (400)', async () => {
    const { app } = makeRuntime()
    const res = await jsonReq(app, 'POST', '/auth/register', {
      email: 'x@example.com', password: 'short',
    })
    expect(res.status).toBe(400)
  })

  it('normalises email to lowercase', async () => {
    const { app } = makeRuntime()
    const res = await jsonReq(app, 'POST', '/auth/register', {
      email: 'CAROL@Example.COM', password: 'password123',
    })
    expect(res.status).toBe(201)
    const { data } = await readJson<{ data: { user: { email: string } } }>(res)
    expect(data.user.email).toBe('carol@example.com')

    // Duplicate detection across case variants
    const dup = await jsonReq(app, 'POST', '/auth/register', {
      email: 'carol@example.com', password: 'whatever1',
    })
    expect(dup.status).toBe(409)
  })
})

// ── Login ────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('returns tokens on valid credentials', async () => {
    const { app } = makeRuntime()
    await jsonReq(app, 'POST', '/auth/register', { email: 'dave@example.com', password: 'mypassword' })

    const res = await jsonReq(app, 'POST', '/auth/login', {
      email: 'dave@example.com', password: 'mypassword',
    })
    expect(res.status).toBe(200)
    const { data } = await readJson<{
      data: { user: { id: string }; accessToken: string; refreshToken: string }
    }>(res)
    expect(data.accessToken.split('.').length).toBe(3)
    expect(data.refreshToken.length).toBeGreaterThan(40)
  })

  it('returns 401 with a generic message on wrong password', async () => {
    const { app } = makeRuntime()
    await jsonReq(app, 'POST', '/auth/register', { email: 'eve@example.com', password: 'rightpw12' })

    const res = await jsonReq(app, 'POST', '/auth/login', {
      email: 'eve@example.com', password: 'wrongpw',
    })
    expect(res.status).toBe(401)
    const { error } = await readJson<{ error: string }>(res)
    expect(error.toLowerCase()).toContain('invalid credentials')
    expect(error.toLowerCase()).not.toContain('password')
    expect(error.toLowerCase()).not.toContain('email')
  })

  it('returns 401 for unknown email — same message as wrong password', async () => {
    const { app } = makeRuntime()
    const res1 = await jsonReq(app, 'POST', '/auth/login', {
      email: 'ghost@example.com', password: 'anything',
    })
    expect(res1.status).toBe(401)
    const { error: e1 } = await readJson<{ error: string }>(res1)

    await jsonReq(app, 'POST', '/auth/register', { email: 'frank@example.com', password: 'mypassword' })
    const res2 = await jsonReq(app, 'POST', '/auth/login', {
      email: 'frank@example.com', password: 'wrong-password',
    })
    expect(res2.status).toBe(401)
    const { error: e2 } = await readJson<{ error: string }>(res2)
    expect(e1).toBe(e2)
  })

  it('issues a fresh refresh token on each login', async () => {
    const { app } = makeRuntime()
    await jsonReq(app, 'POST', '/auth/register', { email: 'h@example.com', password: 'mypassword' })
    const r1 = await readJson<{ data: { refreshToken: string } }>(
      await jsonReq(app, 'POST', '/auth/login', { email: 'h@example.com', password: 'mypassword' })
    )
    const r2 = await readJson<{ data: { refreshToken: string } }>(
      await jsonReq(app, 'POST', '/auth/login', { email: 'h@example.com', password: 'mypassword' })
    )
    expect(r1.data.refreshToken).not.toBe(r2.data.refreshToken)
  })
})

// ── Refresh ──────────────────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  it('returns a new accessToken on valid refresh, rotates the refresh token', async () => {
    const { app } = makeRuntime()
    await jsonReq(app, 'POST', '/auth/register', { email: 'i@example.com', password: 'mypassword' })
    const login = await readJson<{ data: { refreshToken: string; accessToken: string } }>(
      await jsonReq(app, 'POST', '/auth/login', { email: 'i@example.com', password: 'mypassword' })
    )

    const res = await jsonReq(app, 'POST', '/auth/refresh', { refreshToken: login.data.refreshToken })
    expect(res.status).toBe(200)
    const { data } = await readJson<{ data: { accessToken: string; refreshToken: string } }>(res)
    expect(data.accessToken.split('.').length).toBe(3)
    expect(data.refreshToken).not.toBe(login.data.refreshToken)
  })

  it('rejects the old refresh token after rotation (401)', async () => {
    const { app } = makeRuntime()
    await jsonReq(app, 'POST', '/auth/register', { email: 'j@example.com', password: 'mypassword' })
    const login = await readJson<{ data: { refreshToken: string } }>(
      await jsonReq(app, 'POST', '/auth/login', { email: 'j@example.com', password: 'mypassword' })
    )

    await jsonReq(app, 'POST', '/auth/refresh', { refreshToken: login.data.refreshToken })
    const replay = await jsonReq(app, 'POST', '/auth/refresh', {
      refreshToken: login.data.refreshToken,
    })
    expect(replay.status).toBe(401)
  })

  it('rejects an unknown refresh token (401)', async () => {
    const { app } = makeRuntime()
    const res = await jsonReq(app, 'POST', '/auth/refresh', { refreshToken: 'not-a-real-token' })
    expect(res.status).toBe(401)
  })

  it('rejects an expired refresh token (401)', async () => {
    const refreshStore = new MemoryRefreshTokenStore()
    const userStore = new MemoryUserStore()
    process.env['JWT_SECRET'] = 'test-secret'
    const { app } = createRuntime(makeSpec(), {
      ...opts,
      userStore,
      refreshTokenStore: refreshStore,
      jwtSecretLogger: () => {},
    })

    await jsonReq(app, 'POST', '/auth/register', { email: 'k@example.com', password: 'mypassword' })
    const login = await readJson<{ data: { refreshToken: string } }>(
      await jsonReq(app, 'POST', '/auth/login', { email: 'k@example.com', password: 'mypassword' })
    )

    // Inject an expired token directly
    const fakeExpired = 'a'.repeat(96)
    await refreshStore.create({
      tokenHash: hashRefreshToken(fakeExpired),
      userId: (await userStore.findByEmail('k@example.com'))!.id,
      expiresAt: new Date(Date.now() - 1000),
    })

    const res = await jsonReq(app, 'POST', '/auth/refresh', { refreshToken: fakeExpired })
    expect(res.status).toBe(401)

    // Sanity: a fresh login still works
    const ok = await jsonReq(app, 'POST', '/auth/refresh', { refreshToken: login.data.refreshToken })
    expect(ok.status).toBe(200)
  })

  it('rejects a manually revoked refresh token (401)', async () => {
    const refreshStore = new MemoryRefreshTokenStore()
    process.env['JWT_SECRET'] = 'test-secret'
    const { app } = createRuntime(makeSpec(), {
      ...opts,
      userStore: new MemoryUserStore(),
      refreshTokenStore: refreshStore,
      jwtSecretLogger: () => {},
    })

    await jsonReq(app, 'POST', '/auth/register', { email: 'l@example.com', password: 'mypassword' })
    const login = await readJson<{ data: { refreshToken: string } }>(
      await jsonReq(app, 'POST', '/auth/login', { email: 'l@example.com', password: 'mypassword' })
    )
    const stored = await refreshStore.findByHash(hashRefreshToken(login.data.refreshToken))
    expect(stored).not.toBeNull()
    await refreshStore.revoke(stored!.id)

    const res = await jsonReq(app, 'POST', '/auth/refresh', { refreshToken: login.data.refreshToken })
    expect(res.status).toBe(401)
  })
})

// ── Logout ───────────────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  it('revokes the refresh token — refresh after logout fails', async () => {
    const { app } = makeRuntime()
    await jsonReq(app, 'POST', '/auth/register', { email: 'm@example.com', password: 'mypassword' })
    const login = await readJson<{ data: { refreshToken: string } }>(
      await jsonReq(app, 'POST', '/auth/login', { email: 'm@example.com', password: 'mypassword' })
    )

    const logout = await jsonReq(app, 'POST', '/auth/logout', { refreshToken: login.data.refreshToken })
    expect(logout.status).toBe(200)

    const refresh = await jsonReq(app, 'POST', '/auth/refresh', { refreshToken: login.data.refreshToken })
    expect(refresh.status).toBe(401)
  })

  it('is idempotent — logout with an unknown token still returns 200', async () => {
    const { app } = makeRuntime()
    const res = await jsonReq(app, 'POST', '/auth/logout', { refreshToken: 'nothing-here' })
    expect(res.status).toBe(200)
  })
})

// ── /auth/me ────────────────────────────────────────────────────────────────

describe('GET /auth/me', () => {
  it('returns the current user with a valid bearer token', async () => {
    const { app } = makeRuntime()
    const reg = await readJson<{
      data: { user: { id: string; email: string }; accessToken: string }
    }>(await jsonReq(app, 'POST', '/auth/register', {
      email: 'n@example.com', password: 'mypassword',
    }))

    const res = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${reg.data.accessToken}` },
    })
    expect(res.status).toBe(200)
    const { data } = await readJson<{ data: { user: Record<string, unknown> } }>(res)
    expect(data.user['id']).toBe(reg.data.user.id)
    expect(data.user['email']).toBe('n@example.com')
    expect('passwordHash' in data.user).toBe(false)
    expect('salt' in data.user).toBe(false)
  })

  it('returns 401 without Authorization header', async () => {
    const { app } = makeRuntime()
    const res = await app.request('/auth/me')
    expect(res.status).toBe(401)
  })

  it('returns 401 with a bogus token', async () => {
    const { app } = makeRuntime()
    const res = await app.request('/auth/me', {
      headers: { Authorization: 'Bearer not.a.jwt' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 with a token signed by a different secret', async () => {
    const { app } = makeRuntime()
    const other = await generateAccessToken('user-id', 'x@y.z', 'user', 'OTHER_SECRET', 60)
    const res = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${other}` },
    })
    expect(res.status).toBe(401)
  })
})

// ── JWT_SECRET resolution ────────────────────────────────────────────────────

describe('JWT_SECRET resolution', () => {
  it('refuses to start when JWT_SECRET is missing in production', () => {
    process.env['NODE_ENV'] = 'production'
    delete process.env['JWT_SECRET']
    expect(() => createRuntime(makeSpec(), { ...opts, jwtSecretLogger: () => {} }))
      .toThrow(/production.*JWT_SECRET/i)
  })

  it('starts in dev with a warning when JWT_SECRET is missing', () => {
    delete process.env['NODE_ENV']
    delete process.env['JWT_SECRET']
    const lines: string[] = []
    expect(() => createRuntime(makeSpec(), { ...opts, jwtSecretLogger: (l) => lines.push(l) }))
      .not.toThrow()
    expect(lines.some((l) => l.includes('EPHEMERAL'))).toBe(true)
  })

  it('uses a custom env var name when secretEnv is set', () => {
    process.env['MY_JWT_KEY'] = 'custom-secret-value'
    const spec = makeSpec({
      auth: { jwt: { enabled: true, secretEnv: 'MY_JWT_KEY' } },
    })
    const secret = resolveJwtSecret(spec.auth!, () => {})
    expect(secret).toBe('custom-secret-value')
    delete process.env['MY_JWT_KEY']
  })
})

// ── parseTTL ─────────────────────────────────────────────────────────────────

describe('parseTTL', () => {
  it('parses common suffixes', () => {
    expect(parseTTL('60s', 0)).toBe(60)
    expect(parseTTL('5m', 0)).toBe(5 * 60)
    expect(parseTTL('2h', 0)).toBe(2 * 60 * 60)
    expect(parseTTL('7d', 0)).toBe(7 * 24 * 60 * 60)
    expect(parseTTL('120', 0)).toBe(120)
  })

  it('falls back to default on invalid input', () => {
    expect(parseTTL('zilch', 99)).toBe(99)
    expect(parseTTL(undefined, 99)).toBe(99)
  })
})

// ── Schema generation ───────────────────────────────────────────────────────

describe('generatePrismaSchema (Phase 1.2)', () => {
  it('emits User + RefreshToken models when auth.jwt.enabled is true', () => {
    const schema = generatePrismaSchema(makeSpec())
    expect(schema).toContain('model User {')
    expect(schema).toContain('model RefreshToken {')
    expect(schema).toContain('passwordHash')
    expect(schema).toContain('salt')
    expect(schema).toContain('refreshTokens RefreshToken[]')
    expect(schema).toContain('@relation(fields: [userId], references: [id], onDelete: Cascade)')
  })

  it('does not emit JWT models when auth.jwt.enabled is false / missing', () => {
    const schema = generatePrismaSchema({
      version: '1.0', name: 'x',
      resources: [{ name: 'Item', fields: { label: { type: 'string', required: true } } }],
    })
    expect(schema).not.toContain('model User {')
    expect(schema).not.toContain('model RefreshToken {')
  })

  it('rejects a spec with a "User" resource when auth.jwt is enabled', () => {
    expect(() => parseSpec({
      version: '1.0', name: 'x',
      auth: { jwt: { enabled: true } },
      resources: [
        { name: 'User', fields: { name: { type: 'string', required: true } } },
      ],
    })).toThrow(/reserved/i)
  })
})

// ── Disabled = no endpoints (backwards compat) ───────────────────────────────

describe('auth.jwt disabled — backwards compatibility', () => {
  it('does not mount /auth/* when jwt.enabled is not set', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0', name: 'x',
      resources: [{ name: 'Item', fields: { label: { type: 'string', required: true } } }],
    }
    const { app } = createRuntime(spec, opts)
    const res = await jsonReq(app, 'POST', '/auth/register', {
      email: 'a@example.com', password: 'mypassword',
    })
    expect(res.status).toBe(404)
  })

  it('legacy authFlows still works when jwt user system is disabled', async () => {
    const { app } = createRuntime({
      version: '1.0', name: 'legacy',
      resources: [{ name: 'Item', fields: { label: { type: 'string', required: true } } }],
      auth: { strategy: 'jwt', secret: 'legacy-secret' },
      authFlows: { refreshTokens: true, revocation: true },
    }, opts)
    const res = await jsonReq(app, 'POST', '/auth/register', {
      email: 'a@example.com', password: 'mypassword',
    })
    expect(res.status).toBe(201)
  })
})

// ── Combined strategies: jwt + apikey ────────────────────────────────────────

describe('combined jwt + apikey strategies', () => {
  it('accepts either an api key OR a bearer token on a protected resource', async () => {
    process.env['JWT_SECRET'] = 'combo-secret'
    const lines: string[] = []
    const rt = createRuntime({
      version: '1.0', name: 'combo',
      auth: {
        enabled: true,
        strategies: ['jwt', 'apikey'],
        jwt: { enabled: true, secretEnv: 'JWT_SECRET' },
        apikey: { enabled: true },
      },
      resources: [
        { name: 'Widget',
          fields: { label: { type: 'string', required: true } },
          auth: { required: true } },
      ],
    }, {
      ...opts,
      apiKeyBootstrapLogger: (l) => lines.push(l),
      jwtSecretLogger: () => {},
    })

    const apiKey = lines.find((l) => l.trim().startsWith('zak_live_'))?.trim() ?? ''
    expect(apiKey.length).toBeGreaterThan(0)

    // 1. api-key path
    const a = await rt.app.request('/widgets', { headers: { 'x-api-key': apiKey } })
    expect(a.status).toBe(200)

    // 2. jwt path — register, login, hit /widgets with Bearer
    const login = await readJson<{ data: { accessToken: string } }>(
      await jsonReq(rt.app, 'POST', '/auth/register', { email: 'combo@example.com', password: 'mypassword' })
    )
    const b = await rt.app.request('/widgets', {
      headers: { Authorization: `Bearer ${login.data.accessToken}` },
    })
    expect(b.status).toBe(200)

    // 3. nothing → 401
    const c = await rt.app.request('/widgets')
    expect(c.status).toBe(401)
  })
})

// ── PrismaUserStore + PrismaRefreshTokenStore ────────────────────────────────

function makeMockPrisma() {
  const users = new Map<string, PrismaUserRow>()
  const usersByEmail = new Map<string, string>()
  const refreshTokens = new Map<string, PrismaRefreshTokenRow>()
  const refreshByHash = new Map<string, string>()

  const client: PrismaUserLikeClient & PrismaRefreshTokenLikeClient & {
    _users: Map<string, PrismaUserRow>
    _refresh: Map<string, PrismaRefreshTokenRow>
  } = {
    _users: users,
    _refresh: refreshTokens,
    user: {
      async findUnique({ where }) {
        if (where.id) return users.get(where.id) ?? null
        if (where.email) {
          const id = usersByEmail.get(where.email)
          return id ? users.get(id) ?? null : null
        }
        return null
      },
      async create({ data }) {
        const id = 'u_' + (users.size + 1)
        const now = new Date()
        const row: PrismaUserRow = {
          id,
          email: data.email,
          passwordHash: data.passwordHash,
          salt: data.salt,
          role: data.role ?? 'user',
          emailVerified: data.emailVerified ?? false,
          createdAt: now,
          updatedAt: now,
        }
        users.set(id, row)
        usersByEmail.set(data.email, id)
        return row
      },
    },
    refreshToken: {
      async findUnique({ where: { tokenHash } }) {
        const id = refreshByHash.get(tokenHash)
        return id ? refreshTokens.get(id) ?? null : null
      },
      async create({ data }) {
        const id = 'rt_' + (refreshTokens.size + 1)
        const row: PrismaRefreshTokenRow = {
          id,
          tokenHash: data.tokenHash,
          userId: data.userId,
          expiresAt: data.expiresAt,
          revoked: false,
          createdAt: new Date(),
        }
        refreshTokens.set(id, row)
        refreshByHash.set(data.tokenHash, id)
        return row
      },
      async update({ where: { id }, data }) {
        const row = refreshTokens.get(id)
        if (!row) throw new Error('not found')
        if (data.revoked !== undefined) row.revoked = data.revoked
        return row
      },
    },
  }
  return client
}

describe('PrismaUserStore + PrismaRefreshTokenStore', () => {
  it('round-trips create → findByEmail → findById', async () => {
    const prisma = makeMockPrisma()
    const store = new PrismaUserStore(prisma)

    const created = await store.create({
      email: 'p@example.com', passwordHash: 'h', salt: 's', role: 'admin',
    })
    expect(created.role).toBe('admin')

    const byEmail = await store.findByEmail('p@example.com')
    expect(byEmail?.id).toBe(created.id)

    const byId = await store.findById(created.id)
    expect(byId?.email).toBe('p@example.com')
  })

  it('refresh tokens revoke updates the flag', async () => {
    const prisma = makeMockPrisma()
    const store = new PrismaRefreshTokenStore(prisma)
    const r = await store.create({
      tokenHash: 'abc',
      userId: 'u_1',
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(r.revoked).toBe(false)
    expect(await store.revoke(r.id)).toBe(true)
    const after = await store.findByHash('abc')
    expect(after?.revoked).toBe(true)
  })

  it('createRuntime uses prismaJwt and the /auth/register round-trip works', async () => {
    process.env['JWT_SECRET'] = 'prisma-secret'
    const prisma = makeMockPrisma()
    const { app } = createRuntime(makeSpec(), {
      ...opts,
      prismaJwt: prisma,
      jwtSecretLogger: () => {},
    })

    const reg = await jsonReq(app, 'POST', '/auth/register', {
      email: 'prisma@example.com', password: 'mypassword',
    })
    expect(reg.status).toBe(201)
    expect(prisma._users.size).toBe(1)
    expect(prisma._refresh.size).toBe(1)
  })

  it('refuses memory fallback in production for the JWT user system', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['JWT_SECRET'] = 'x'
    delete process.env['DATABASE_URL']
    expect(() => createRuntime(makeSpec(), { ...opts, jwtSecretLogger: () => {} }))
      .toThrow(/auth\.jwt.*production/i)
  })
})
