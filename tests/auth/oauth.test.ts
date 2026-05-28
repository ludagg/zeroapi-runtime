import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRuntime,
  parseSpec,
  generatePrismaSchema,
  MemoryOAuthAccountStore,
  MemoryOAuthStateStore,
  MemoryUserStore,
  MemoryRefreshTokenStore,
  buildOAuthCallbackUrl,
  getOAuthCallbackUrls,
  listConfiguredOAuthProviderNames,
  OAUTH_CALLBACK_BASE_ENV,
} from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const opts = {
  enableLogging: false,
  enableDocs: false,
  enableHelmet: false,
  enableCors: false,
  enableSanitize: false,
} as const

const SAVED_ENV: Record<string, string | undefined> = {}
function snapshotEnv(...names: string[]): void {
  for (const n of names) SAVED_ENV[n] = process.env[n]
}
function restoreEnv(): void {
  for (const [n, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[n]
    else process.env[n] = v
  }
}

function makeOAuthSpec(overrides: Partial<ZeroAPISpec> = {}): ZeroAPISpec {
  return {
    version: '1.0.0',
    name: 'oauth-test',
    auth: {
      enabled: true,
      strategies: ['jwt', 'oauth'],
      jwt: { enabled: true, secretEnv: 'JWT_SECRET' },
      oauth: {
        providers: [
          { name: 'google', clientIdEnv: 'GOOGLE_ID', clientSecretEnv: 'GOOGLE_SECRET' },
          { name: 'github', clientIdEnv: 'GH_ID', clientSecretEnv: 'GH_SECRET' },
          { name: 'apple', clientIdEnv: 'APPLE_ID', clientSecretEnv: 'APPLE_SECRET' },
        ],
      },
    },
    resources: [{ name: 'Widget', fields: { label: { type: 'string', required: true } } }],
    ...overrides,
  }
}

// ── Fake fetch builder ────────────────────────────────────────────────────────

interface FakeResponseShape {
  status?: number
  body: unknown
}

function makeFakeFetch(
  routes: Record<string, FakeResponseShape | ((body: string | undefined) => FakeResponseShape)>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; body?: string }> } {
  const calls: Array<{ url: string; body?: string }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url, ...(body !== undefined ? { body } : {}) })
    const matched = Object.entries(routes).find(([key]) => url.startsWith(key))
    if (!matched) {
      return new Response('not mocked: ' + url, { status: 599 })
    }
    const handler = matched[1]
    const shape = typeof handler === 'function' ? handler(body) : handler
    return new Response(JSON.stringify(shape.body), {
      status: shape.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  snapshotEnv(
    'JWT_SECRET',
    'OAUTH_CALLBACK_BASE_URL',
    'GOOGLE_ID', 'GOOGLE_SECRET',
    'GH_ID', 'GH_SECRET',
    'APPLE_ID', 'APPLE_SECRET',
    'NODE_ENV',
  )
  process.env['JWT_SECRET'] = 'oauth-test-secret'
  process.env['OAUTH_CALLBACK_BASE_URL'] = 'https://api.example.com'
  process.env['GOOGLE_ID'] = 'google-id'
  process.env['GOOGLE_SECRET'] = 'google-secret'
  process.env['GH_ID'] = 'github-id'
  process.env['GH_SECRET'] = 'github-secret'
})
afterEach(() => { restoreEnv() })

// ── Parser ────────────────────────────────────────────────────────────────────

describe('parser — OAuth requires JWT', () => {
  it('rejects an OAuth spec without auth.jwt.enabled', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'no-jwt',
        auth: {
          enabled: true,
          oauth: { providers: [{ name: 'google', clientIdEnv: 'X', clientSecretEnv: 'Y' }] },
        },
        resources: [{ name: 'Item', fields: { label: { type: 'string', required: true } } }],
      }),
    ).toThrow(/oauth.*jwt/i)
  })

  it('accepts OAuth when auth.jwt.enabled is true', () => {
    const spec = parseSpec(makeOAuthSpec())
    expect(spec.auth?.oauth?.providers).toHaveLength(3)
  })

  it('rejects a spec with an "OAuthAccount" resource when OAuth is configured', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'reserved',
        auth: {
          jwt: { enabled: true },
          oauth: { providers: [{ name: 'google', clientIdEnv: 'X', clientSecretEnv: 'Y' }] },
        },
        resources: [
          { name: 'OAuthAccount', fields: { name: { type: 'string', required: true } } },
        ],
      }),
    ).toThrow(/reserved/i)
  })
})

// ── Initiation endpoint ──────────────────────────────────────────────────────

describe('GET /auth/oauth/:provider', () => {
  it('redirects to the Google consent page with a state token', async () => {
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const res = await app.request('/auth/oauth/google', { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = res.headers.get('Location') ?? ''
    expect(loc).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    expect(loc).toContain('client_id=google-id')
    expect(loc).toContain('state=')
    expect(loc).toContain('redirect_uri=' + encodeURIComponent('https://api.example.com/auth/oauth/google/callback'))
  })

  it('redirects to the GitHub authorize page', async () => {
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const res = await app.request('/auth/oauth/github', { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('github.com/login/oauth/authorize')
  })

  it('returns 501 for an unconfigured provider (missing env vars)', async () => {
    delete process.env['GOOGLE_ID']
    delete process.env['GOOGLE_SECRET']
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const res = await app.request('/auth/oauth/google')
    expect(res.status).toBe(501)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('non configuré')
  })

  it('returns 501 for the Apple stub', async () => {
    process.env['APPLE_ID'] = 'a'
    process.env['APPLE_SECRET'] = 'b'
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const res = await app.request('/auth/oauth/apple')
    expect(res.status).toBe(501)
    const body = await res.json() as { error: string }
    expect(body.error.toLowerCase()).toContain('not yet implemented')
  })

  it('returns 501 when OAUTH_CALLBACK_BASE_URL is missing', async () => {
    delete process.env['OAUTH_CALLBACK_BASE_URL']
    const warnings: string[] = []
    const { app } = createRuntime(makeOAuthSpec(), {
      ...opts,
      jwtSecretLogger: () => {},
      oauthWarningLogger: (l) => warnings.push(l),
    })
    const res = await app.request('/auth/oauth/google')
    expect(res.status).toBe(501)
    expect(warnings.some((l) => l.includes('OAUTH_CALLBACK_BASE_URL'))).toBe(true)
  })

  it('returns 404 for a provider not in the spec', async () => {
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const res = await app.request('/auth/oauth/twitter')
    expect(res.status).toBe(404)
  })
})

// ── Callback endpoint ────────────────────────────────────────────────────────

async function obtainState(app: Awaited<ReturnType<typeof createRuntime>>['app'], provider: string): Promise<string> {
  const res = await app.request(`/auth/oauth/${provider}`, { redirect: 'manual' })
  const loc = res.headers.get('Location') ?? ''
  const match = /[?&]state=([^&]+)/.exec(loc)
  return decodeURIComponent(match?.[1] ?? '')
}

describe('GET /auth/oauth/:provider/callback', () => {
  it('creates a new user and returns tokens (Google, fresh account)', async () => {
    const { fetchImpl } = makeFakeFetch({
      'https://oauth2.googleapis.com/token': { body: { access_token: 'g-access' } },
      'https://openidconnect.googleapis.com/v1/userinfo': {
        body: { sub: 'g-sub-1', email: 'alice@example.com', name: 'Alice' },
      },
    })
    const { app } = createRuntime(makeOAuthSpec(), {
      ...opts, jwtSecretLogger: () => {}, oauthFetch: fetchImpl,
    })

    const state = await obtainState(app, 'google')
    const res = await app.request(`/auth/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      data: { user: { email: string; role: string; emailVerified: boolean }; accessToken: string; refreshToken: string }
    }
    expect(body.data.user.email).toBe('alice@example.com')
    expect(body.data.user.emailVerified).toBe(true)
    expect(body.data.user.role).toBe('user')
    expect(body.data.accessToken.split('.').length).toBe(3)
    expect(body.data.refreshToken.length).toBeGreaterThan(40)
  })

  it('logs in an existing user matched by email (account linking, no duplicate)', async () => {
    const userStore = new MemoryUserStore()
    const refreshStore = new MemoryRefreshTokenStore()
    const oauthAccounts = new MemoryOAuthAccountStore()

    // Pre-existing local user
    await userStore.create({ email: 'bob@example.com', passwordHash: 'x', salt: 'y' })

    const { fetchImpl } = makeFakeFetch({
      'https://oauth2.googleapis.com/token': { body: { access_token: 'g-access' } },
      'https://openidconnect.googleapis.com/v1/userinfo': {
        body: { sub: 'bob-sub', email: 'BOB@Example.com' },
      },
    })
    const { app } = createRuntime(makeOAuthSpec(), {
      ...opts,
      jwtSecretLogger: () => {},
      userStore,
      refreshTokenStore: refreshStore,
      oauthAccountStore: oauthAccounts,
      oauthFetch: fetchImpl,
    })

    const state = await obtainState(app, 'google')
    const res = await app.request(`/auth/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(200)

    // No duplicate user — still one
    const link = await oauthAccounts.findByProviderAndProviderId('google', 'bob-sub')
    expect(link).not.toBeNull()
    expect((await userStore.findByEmail('bob@example.com'))?.id).toBe(link?.userId)
  })

  it('reuses the existing OAuth link on second sign-in', async () => {
    const userStore = new MemoryUserStore()
    const refreshStore = new MemoryRefreshTokenStore()
    const oauthAccounts = new MemoryOAuthAccountStore()

    const { fetchImpl } = makeFakeFetch({
      'https://oauth2.googleapis.com/token': { body: { access_token: 'g-access' } },
      'https://openidconnect.googleapis.com/v1/userinfo': {
        body: { sub: 'c-sub', email: 'carol@example.com' },
      },
    })
    const { app } = createRuntime(makeOAuthSpec(), {
      ...opts,
      jwtSecretLogger: () => {},
      userStore,
      refreshTokenStore: refreshStore,
      oauthAccountStore: oauthAccounts,
      oauthFetch: fetchImpl,
    })

    const s1 = await obtainState(app, 'google')
    await app.request(`/auth/oauth/google/callback?code=c&state=${encodeURIComponent(s1)}`)
    const s2 = await obtainState(app, 'google')
    await app.request(`/auth/oauth/google/callback?code=c&state=${encodeURIComponent(s2)}`)

    const links = await oauthAccounts.findByUserId(
      (await userStore.findByEmail('carol@example.com'))!.id,
    )
    expect(links).toHaveLength(1)
  })

  it('rejects an invalid CSRF state with 401', async () => {
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const res = await app.request('/auth/oauth/google/callback?code=abc&state=not-a-real-state')
    expect(res.status).toBe(401)
  })

  it('rejects a missing state with 401', async () => {
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const res = await app.request('/auth/oauth/google/callback?code=abc')
    expect(res.status).toBe(401)
  })

  it('rejects a missing code with 400', async () => {
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const state = await obtainState(app, 'google')
    const res = await app.request(`/auth/oauth/google/callback?state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(400)
  })

  it('propagates provider error= query as 400', async () => {
    const { app } = createRuntime(makeOAuthSpec(), { ...opts, jwtSecretLogger: () => {} })
    const state = await obtainState(app, 'google')
    const res = await app.request(`/auth/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(400)
  })

  it('returns 502 when the provider token endpoint fails', async () => {
    const { fetchImpl } = makeFakeFetch({
      'https://oauth2.googleapis.com/token': { status: 500, body: { error: 'boom' } },
    })
    const { app } = createRuntime(makeOAuthSpec(), {
      ...opts, jwtSecretLogger: () => {}, oauthFetch: fetchImpl,
    })
    const state = await obtainState(app, 'google')
    const res = await app.request(`/auth/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(502)
  })

  it('falls back to the GitHub /user/emails endpoint when /user hides the address', async () => {
    // Order matters: more specific routes first (startsWith match).
    const { fetchImpl, calls } = makeFakeFetch({
      'https://github.com/login/oauth/access_token': { body: { access_token: 'gh-access' } },
      'https://api.github.com/user/emails': {
        body: [
          { email: 'public@nope.com', primary: false, verified: false },
          { email: 'dave@example.com', primary: true, verified: true },
        ],
      },
      'https://api.github.com/user': {
        body: { id: 4242, email: null, name: 'Dave', login: 'dave' },
      },
    })
    const { app } = createRuntime(makeOAuthSpec(), {
      ...opts, jwtSecretLogger: () => {}, oauthFetch: fetchImpl,
    })
    const state = await obtainState(app, 'github')
    const res = await app.request(`/auth/oauth/github/callback?code=c&state=${encodeURIComponent(state)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { user: { email: string } } }
    expect(body.data.user.email).toBe('dave@example.com')
    expect(calls.some((c) => c.url.includes('/user/emails'))).toBe(true)
  })

  it('redirects to redirectTo with tokens in the URL fragment when set', async () => {
    const { fetchImpl } = makeFakeFetch({
      'https://oauth2.googleapis.com/token': { body: { access_token: 'g-access' } },
      'https://openidconnect.googleapis.com/v1/userinfo': {
        body: { sub: 'r-sub', email: 'redirect@example.com' },
      },
    })
    const { app } = createRuntime(makeOAuthSpec(), {
      ...opts, jwtSecretLogger: () => {}, oauthFetch: fetchImpl,
    })
    const init = await app.request('/auth/oauth/google?redirectTo=' + encodeURIComponent('https://app.example.com/oauth-done'), { redirect: 'manual' })
    const loc = init.headers.get('Location') ?? ''
    const state = decodeURIComponent(/[?&]state=([^&]+)/.exec(loc)?.[1] ?? '')

    const res = await app.request(`/auth/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const target = res.headers.get('Location') ?? ''
    expect(target.startsWith('https://app.example.com/oauth-done#')).toBe(true)
    expect(target).toContain('accessToken=')
    expect(target).toContain('refreshToken=')
  })
})

// ── Schema generation ───────────────────────────────────────────────────────

describe('generatePrismaSchema — OAuth', () => {
  it('emits the OAuthAccount model and the User back-relation when OAuth is configured', () => {
    const schema = generatePrismaSchema(makeOAuthSpec())
    expect(schema).toContain('model OAuthAccount {')
    expect(schema).toContain('provider   String')
    expect(schema).toContain('providerId String')
    expect(schema).toContain('@@unique([provider, providerId])')
    expect(schema).toContain('oauthAccounts OAuthAccount[]')
  })

  it('does not emit OAuthAccount when OAuth is not configured', () => {
    const schema = generatePrismaSchema({
      version: '1.0', name: 'x',
      auth: { jwt: { enabled: true } },
      resources: [{ name: 'Item', fields: { label: { type: 'string', required: true } } }],
    })
    expect(schema).not.toContain('model OAuthAccount {')
    expect(schema).not.toContain('oauthAccounts')
  })
})

// ── Disabled = no endpoints ─────────────────────────────────────────────────

describe('OAuth disabled — backwards compat', () => {
  it('does not mount /auth/oauth/* when no OAuth providers are declared', async () => {
    const { app } = createRuntime(
      {
        version: '1.0', name: 'no-oauth',
        auth: { jwt: { enabled: true }, strategies: ['jwt'] },
        resources: [{ name: 'Item', fields: { label: { type: 'string', required: true } } }],
      },
      { ...opts, jwtSecretLogger: () => {} },
    )
    const res = await app.request('/auth/oauth/google')
    expect(res.status).toBe(404)
  })
})

// ── Helpers ──────────────────────────────────────────────────────────────────

describe('OAuth helpers', () => {
  it('buildOAuthCallbackUrl strips a trailing slash', () => {
    expect(buildOAuthCallbackUrl('https://api.example.com/', 'google'))
      .toBe('https://api.example.com/auth/oauth/google/callback')
  })

  it('getOAuthCallbackUrls returns one entry per configured provider', () => {
    const urls = getOAuthCallbackUrls(makeOAuthSpec().auth!, 'https://api.example.com')
    expect(urls.map((u) => u.provider)).toEqual(['google', 'github', 'apple'])
    expect(urls[0]!.message).toContain('https://api.example.com/auth/oauth/google/callback')
  })

  it('getOAuthCallbackUrls returns [] when base URL is missing', () => {
    delete process.env[OAUTH_CALLBACK_BASE_ENV]
    expect(getOAuthCallbackUrls(makeOAuthSpec().auth!)).toEqual([])
  })

  it('listConfiguredOAuthProviderNames lists declared providers', () => {
    const names = listConfiguredOAuthProviderNames(makeOAuthSpec().auth!)
    expect(names).toEqual(['google', 'github', 'apple'])
  })
})

// ── State store ──────────────────────────────────────────────────────────────

describe('MemoryOAuthStateStore', () => {
  it('consumes a state at most once', async () => {
    const store = new MemoryOAuthStateStore()
    const { state } = await store.create('google')
    expect((await store.consume(state))?.provider).toBe('google')
    expect(await store.consume(state)).toBeNull()
  })

  it('expires entries after the TTL window', async () => {
    const store = new MemoryOAuthStateStore(1) // 1ms TTL — tiny but deterministic
    const { state } = await store.create('google')
    await new Promise((r) => setTimeout(r, 5))
    expect(await store.consume(state)).toBeNull()
  })
})
