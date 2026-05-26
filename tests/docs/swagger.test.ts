import { describe, it, expect } from 'vitest'
import { generateOpenAPISpec } from '../../src/docs/swagger.js'
import { sampleSpec } from '../fixtures/sample-spec.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

describe('generateOpenAPISpec', () => {
  it('returns openapi 3.0.3', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(spec.openapi).toBe('3.0.3')
  })

  it('sets info from spec', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(spec.info.title).toBe(sampleSpec.name)
    expect(spec.info.version).toBe(sampleSpec.version)
  })

  it('generates paths for every resource', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(spec.paths['/users']).toBeDefined()
    expect(spec.paths['/posts']).toBeDefined()
  })

  it('generates collection and item paths', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(spec.paths['/users']).toBeDefined()
    expect(spec.paths['/users/{id}']).toBeDefined()
  })

  it('includes GET, POST on collection path', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(spec.paths['/users']?.['get']).toBeDefined()
    expect(spec.paths['/users']?.['post']).toBeDefined()
  })

  it('includes GET, PUT, DELETE on item path', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(spec.paths['/users/{id}']?.['get']).toBeDefined()
    expect(spec.paths['/users/{id}']?.['put']).toBeDefined()
    expect(spec.paths['/users/{id}']?.['delete']).toBeDefined()
  })

  it('generates schemas for every resource', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(spec.components.schemas['User']).toBeDefined()
    expect(spec.components.schemas['CreateUser']).toBeDefined()
    expect(spec.components.schemas['UpdateUser']).toBeDefined()
    expect(spec.components.schemas['Post']).toBeDefined()
  })

  it('adds bearerAuth scheme when spec has JWT auth', () => {
    const securedSpec: ZeroAPISpec = {
      ...sampleSpec,
      auth: { strategy: 'jwt', secret: 'test' },
    }
    const spec = generateOpenAPISpec(securedSpec)
    expect(spec.components.securitySchemes?.['bearerAuth']).toBeDefined()
  })

  it('respects endpoint restrictions', () => {
    const readOnlySpec: ZeroAPISpec = {
      version: '1.0',
      name: 'read-only',
      resources: [
        {
          name: 'News',
          fields: { headline: { type: 'string', required: true } },
          endpoints: ['list', 'read'],
        },
      ],
    }
    const spec = generateOpenAPISpec(readOnlySpec)
    expect(spec.paths['/news']?.['get']).toBeDefined()
    expect(spec.paths['/news']?.['post']).toBeUndefined()
    expect(spec.paths['/news/{id}']?.['delete']).toBeUndefined()
  })

  it('includes tags per resource', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(spec.tags?.some((t) => t.name === 'User')).toBe(true)
    expect(spec.tags?.some((t) => t.name === 'Post')).toBe(true)
  })
})
