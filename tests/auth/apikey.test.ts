import { describe, it, expect } from 'vitest'
import {
  createRuntime,
  generateApiKey,
  hashApiKey,
  MemoryApiKeyStore,
  bootstrapMemoryApiKeysSync,
  generatePrismaSchema,
} from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<ZeroAPISpec> = {}): ZeroAPISpec {
  return {
    version: '1.0.0',
    name: 'apikey-test',
    auth: {
      enabled: true,
      strategies: ['apikey'],
      apikey: { enabled: true, header: 'x-api-key', prefix: 'zak_live_' },
    },
    resources: [
      {
        name: 'Widget',
        fields: {
          label: { type: 'string', required: true },
        },
        auth: { required: true },
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

function makeBootstrapCapture(): { lines: string[]; logger: (l: string) => void; getKey: () => string } {
  const lines: string[] = []
  return {
    lines,
    logger: (l) => lines.push(l),
    getKey: () => {
      const line = lines.find((l) => l.trim().startsWith('zak_live_'))
      if (!line) throw new Error('bootstrap key not found in log lines')
      return line.trim()
    },
  }
}

function newRuntime(spec = makeSpec()) {
  const capture = makeBootstrapCapture()
  const result = createRuntime(spec, { ...opts, apiKeyBootstrapLogger: capture.logger })
  return { ...result, ...capture }
}

// ── generateApiKey / hashApiKey ───────────────────────────────────────────────

describe('generateApiKey', () => {
  it('returns key/keyHash/keyPrefix triple', () => {
    const { key, keyHash, keyPrefix } = generateApiKey()
    expect(key.startsWith('zak_live_')).toBe(true)
    expect(key.length).toBe('zak_live_'.length + 64)
    expect(keyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(keyPrefix).toBe(key.slice(0, 16))
  })

  it('honours custom prefix', () => {
    const { key, keyPrefix } = generateApiKey('zak_test_')
    expect(key.startsWith('zak_test_')).toBe(true)
    expect(keyPrefix).toBe(key.slice(0, 16))
  })

  it('keys are unpredictable', () => {
    const a = generateApiKey().key
    const b = generateApiKey().key
    expect(a).not.toBe(b)
  })
})

describe('hashApiKey', () => {
  it('is deterministic for the same input', () => {
    const k = 'zak_live_deadbeef'
    expect(hashApiKey(k)).toBe(hashApiKey(k))
  })

  it('matches the hash produced by generateApiKey', () => {
    const { key, keyHash } = generateApiKey()
    expect(hashApiKey(key)).toBe(keyHash)
  })
})

// ── Middleware verification ──────────────────────────────────────────────────

describe('apikey middleware', () => {
  it('200 for a valid bootstrap key', async () => {
    const { app, getKey } = newRuntime()
    const key = getKey()
    const res = await app.request('/widgets', { headers: { 'x-api-key': key } })
    expect(res.status).toBe(200)
  })

  it('401 with no header', async () => {
    const { app } = newRuntime()
    const res = await app.request('/widgets')
    expect(res.status).toBe(401)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('Invalid API key')
  })

  it('401 with a syntactically valid but unknown key', async () => {
    const { app } = newRuntime()
    const res = await app.request('/widgets', {
      headers: { 'x-api-key': 'zak_live_' + 'a'.repeat(64) },
    })
    expect(res.status).toBe(401)
  })

  it('401 with a short / garbage key', async () => {
    const { app } = newRuntime()
    const res = await app.request('/widgets', { headers: { 'x-api-key': 'nope' } })
    expect(res.status).toBe(401)
  })

  it('401 once the key is revoked', async () => {
    const { app, getKey } = newRuntime()
    const adminKey = getKey()

    const listRes = await app.request('/admin/api-keys', { headers: { 'x-api-key': adminKey } })
    const { data } = await listRes.json() as { data: Array<{ id: string }> }
    const id = data[0]!.id

    const del = await app.request(`/admin/api-keys/${id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': adminKey },
    })
    expect(del.status).toBe(200)

    const res = await app.request('/widgets', { headers: { 'x-api-key': adminKey } })
    expect(res.status).toBe(401)
  })

  it('legacy strategy:"apikey" shape activates real verification', async () => {
    const spec = makeSpec({
      auth: { strategy: 'apikey', header: 'x-api-key' },
    })
    const { app, getKey } = newRuntime(spec)
    const key = getKey()

    const good = await app.request('/widgets', { headers: { 'x-api-key': key } })
    expect(good.status).toBe(200)

    const bad = await app.request('/widgets', { headers: { 'x-api-key': 'aaaaaaaaaaaaaaaaaaaaa' } })
    expect(bad.status).toBe(401)
  })
})

// ── Admin endpoints ──────────────────────────────────────────────────────────

describe('admin api-key endpoints', () => {
  it('POST /admin/api-keys returns the plaintext key exactly once', async () => {
    const { app, getKey } = newRuntime()
    const adminKey = getKey()

    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mobile-app' }),
    })
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { id: string; key: string; keyPrefix: string; name: string } }
    expect(data.key.startsWith('zak_live_')).toBe(true)
    expect(data.keyPrefix.length).toBe(16)
    expect(data.name).toBe('mobile-app')

    // Listing must never expose the plaintext key
    const listRes = await app.request('/admin/api-keys', { headers: { 'x-api-key': adminKey } })
    const { data: list } = await listRes.json() as { data: Array<Record<string, unknown>> }
    for (const entry of list) {
      expect('key' in entry).toBe(false)
      expect('keyHash' in entry).toBe(false)
    }
    const mobile = list.find((e) => e['name'] === 'mobile-app')
    expect(mobile).toBeDefined()
    expect(mobile!['keyPrefix']).toBe(data.keyPrefix)
  })

  it('a freshly issued key works for subsequent requests', async () => {
    const { app, getKey } = newRuntime()
    const adminKey = getKey()

    const createRes = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const { data } = await createRes.json() as { data: { key: string } }

    const res = await app.request('/widgets', { headers: { 'x-api-key': data.key } })
    expect(res.status).toBe(200)
  })

  it('DELETE /admin/api-keys/:id revokes the key', async () => {
    const { app, getKey } = newRuntime()
    const adminKey = getKey()

    const createRes = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'temp' }),
    })
    const { data } = await createRes.json() as { data: { id: string; key: string } }

    const del = await app.request(`/admin/api-keys/${data.id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': adminKey },
    })
    expect(del.status).toBe(200)

    const res = await app.request('/widgets', { headers: { 'x-api-key': data.key } })
    expect(res.status).toBe(401)
  })

  it('admin endpoints reject calls without a valid key', async () => {
    const { app } = newRuntime()
    const res = await app.request('/admin/api-keys')
    expect(res.status).toBe(401)
  })

  it('DELETE on an unknown id returns 404', async () => {
    const { app, getKey } = newRuntime()
    const adminKey = getKey()
    const res = await app.request('/admin/api-keys/does-not-exist', {
      method: 'DELETE',
      headers: { 'x-api-key': adminKey },
    })
    expect(res.status).toBe(404)
  })
})

// ── Bootstrap ────────────────────────────────────────────────────────────────

describe('bootstrap', () => {
  it('generates and logs an initial key when the store is empty', () => {
    const { lines, getKey } = newRuntime()
    expect(lines.some((l) => l.includes('Clé API initiale'))).toBe(true)
    expect(lines.some((l) => l.includes('plus jamais affichée'))).toBe(true)
    expect(getKey().startsWith('zak_live_')).toBe(true)
  })

  it('skips bootstrap when the store already has keys', async () => {
    const store = new MemoryApiKeyStore()
    const seeded = generateApiKey()
    await store.create({ keyHash: seeded.keyHash, keyPrefix: seeded.keyPrefix, name: 'seed' })

    const lines: string[] = []
    const { app } = createRuntime(makeSpec(), {
      ...opts,
      apiKeyStore: store,
      apiKeyBootstrapLogger: (l) => lines.push(l),
    })

    expect(lines).toEqual([])

    const res = await app.request('/widgets', { headers: { 'x-api-key': seeded.key } })
    expect(res.status).toBe(200)
  })

  it('bootstrapMemoryApiKeysSync is idempotent on a non-empty store', () => {
    const store = new MemoryApiKeyStore()
    const first = bootstrapMemoryApiKeysSync({}, store, () => { /* silent */ })
    expect(first.generated).toBeDefined()
    const second = bootstrapMemoryApiKeysSync({}, store, () => { /* silent */ })
    expect(second.generated).toBeUndefined()
  })
})

// ── Spec/Prisma integration ──────────────────────────────────────────────────

describe('prisma schema', () => {
  it('includes the ApiKey model when apikey auth is enabled (modern shape)', () => {
    const schema = generatePrismaSchema(makeSpec())
    expect(schema).toContain('model ApiKey {')
    expect(schema).toContain('keyHash')
    expect(schema).toContain('@unique')
  })

  it('includes the ApiKey model when apikey auth is enabled (legacy shape)', () => {
    const schema = generatePrismaSchema(makeSpec({ auth: { strategy: 'apikey' } }))
    expect(schema).toContain('model ApiKey {')
  })

  it('omits the ApiKey model when no auth is configured', () => {
    const schema = generatePrismaSchema(makeSpec({ auth: undefined }))
    expect(schema).not.toContain('model ApiKey')
  })

  it('omits the ApiKey model for JWT-only auth', () => {
    const schema = generatePrismaSchema(makeSpec({
      auth: { strategy: 'jwt', secret: 'x' },
    }))
    expect(schema).not.toContain('model ApiKey')
  })
})

// ── Backwards compatibility ──────────────────────────────────────────────────

describe('backwards compatibility', () => {
  it('spec with no auth block is unaffected', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'no-auth',
      resources: [{ name: 'Widget', fields: { label: { type: 'string', required: true } } }],
    }
    const { app } = createRuntime(spec, opts)
    const res = await app.request('/widgets')
    expect(res.status).toBe(200)
  })

  it('JWT auth path still works (no apikey wiring)', async () => {
    const spec = makeSpec({ auth: { strategy: 'jwt', secret: 'shh' } })
    const { app } = createRuntime(spec, opts)

    const noAuth = await app.request('/widgets')
    expect(noAuth.status).toBe(401)
  })
})
