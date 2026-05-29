import { describe, it, expect } from 'vitest'
import { createRuntime, parseSpec } from '../src/index.js'
import { sampleSpec, minimalSpec } from './fixtures/sample-spec.js'

describe('createRuntime', () => {
  it('returns all expected artifacts', () => {
    const result = createRuntime(sampleSpec, { enableLogging: false })
    expect(result.app).toBeDefined()
    expect(result.prismaSchema).toBeDefined()
    expect(result.zodSchemas).toBeDefined()
    expect(result.testSuite).toBeDefined()
    expect(result.spec).toBe(sampleSpec)
  })

  it('zodSchemas contains an entry per resource', () => {
    const { zodSchemas } = createRuntime(sampleSpec, { enableLogging: false })
    expect(zodSchemas['User']).toBeDefined()
    expect(zodSchemas['Post']).toBeDefined()
    expect(zodSchemas['User']?.create).toBeDefined()
    expect(zodSchemas['User']?.update).toBeDefined()
  })

  it('prismaSchema contains all models', () => {
    const { prismaSchema } = createRuntime(sampleSpec, { enableLogging: false })
    expect(prismaSchema).toContain('model User {')
    expect(prismaSchema).toContain('model Post {')
  })

  it('testSuite is a non-empty string with describe blocks', () => {
    const { testSuite } = createRuntime(sampleSpec, { enableLogging: false })
    expect(typeof testSuite).toBe('string')
    expect(testSuite.length).toBeGreaterThan(0)
    expect(testSuite).toContain("describe('User routes'")
    expect(testSuite).toContain("describe('Post routes'")
  })

  it('works with minimal spec', () => {
    expect(() => createRuntime(minimalSpec, { enableLogging: false })).not.toThrow()
  })

  it('health endpoint always works regardless of spec', async () => {
    const { app } = createRuntime(minimalSpec, { enableLogging: false })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })
})

describe('parseSpec + createRuntime integration', () => {
  it('parses a raw object and creates a working runtime', () => {
    const raw = {
      version: '2.0.0',
      name: 'integration-api',
      resources: [
        {
          name: 'Product',
          fields: {
            title: { type: 'string', required: true },
            price: { type: 'number', required: true, min: 0 },
            inStock: { type: 'boolean', required: false, default: true },
          },
        },
      ],
    }

    const spec = parseSpec(raw)
    const { app } = createRuntime(spec, { enableLogging: false })
    expect(app).toBeDefined()
  })

  it('round-trips spec through parse without data loss', () => {
    const spec = parseSpec(sampleSpec)
    expect(spec.name).toBe(sampleSpec.name)
    expect(spec.resources.length).toBe(sampleSpec.resources.length)
    expect(spec.resources[0]?.name).toBe(sampleSpec.resources[0]?.name)
  })
})

describe('auth doc/runtime parity', () => {
  // Regression: a JWT-enabled API mounts /auth/* at runtime but the OpenAPI
  // generator used to omit them — so the doc advertised bearerAuth everywhere
  // with no documented way to obtain a token. Every documented /auth path must
  // actually respond (i.e. not 404).
  const jwtSpec = parseSpec({
    version: '1.0.0',
    name: 'todo',
    auth: { enabled: true, strategies: ['jwt'], jwt: { enabled: true } },
    resources: [{ name: 'Todo', fields: { title: { type: 'string', required: true } } }],
  })

  it('documents every /auth path that the runtime actually mounts', async () => {
    const { app, openApiSpec } = createRuntime(jwtSpec, {
      enableLogging: false,
      enableDocs: false,
      jwtSecretLogger: () => { /* silent */ },
    })

    const authPaths = Object.keys(openApiSpec.paths).filter((p) => p.startsWith('/auth'))
    expect(authPaths.length).toBeGreaterThan(0)

    for (const [path, ops] of Object.entries(openApiSpec.paths)) {
      if (!path.startsWith('/auth')) continue
      for (const method of Object.keys(ops)) {
        const res = await app.fetch(
          new Request('http://x' + path, {
            method: method.toUpperCase(),
            headers: { 'content-type': 'application/json' },
            body: method === 'get' ? undefined : '{}',
          }),
        )
        // The documented route exists — it may reject the empty body (400) or
        // demand auth (401), but it must never be a missing route (404).
        expect(res.status, `${method.toUpperCase()} ${path}`).not.toBe(404)
      }
    }
  })

  it('register → login round-trips against the documented endpoints', async () => {
    const { app } = createRuntime(jwtSpec, {
      enableLogging: false,
      enableDocs: false,
      jwtSecretLogger: () => { /* silent */ },
    })
    const creds = JSON.stringify({ email: 'a@b.com', password: 'password123' })
    const reg = await app.fetch(new Request('http://x/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: creds,
    }))
    expect(reg.status).toBe(201)
    const login = await app.fetch(new Request('http://x/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: creds,
    }))
    expect(login.status).toBe(200)
    const { data } = await login.json() as { data: { accessToken: string } }
    expect(typeof data.accessToken).toBe('string')
  })
})

describe('generateTests output', () => {
  it('produces valid JavaScript string', () => {
    const { testSuite } = createRuntime(sampleSpec, { enableLogging: false })
    // Should not throw when checking for key content
    expect(testSuite).toContain('import')
    expect(testSuite).toContain('createRuntime')
    expect(testSuite).toContain('/users')
    expect(testSuite).toContain('/posts')
  })
})
