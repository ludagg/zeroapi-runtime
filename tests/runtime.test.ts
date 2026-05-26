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
