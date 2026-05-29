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

  // ── Auth endpoints — must be documented so clients can obtain a token ────────

  const jwtSpec: ZeroAPISpec = {
    version: '1.0.0',
    name: 'todo',
    auth: { enabled: true, strategies: ['jwt'], jwt: { enabled: true } },
    resources: [{ name: 'Todo', fields: { title: { type: 'string', required: true } } }],
  }

  it('emits the JWT user-system paths when auth.jwt.enabled is true', () => {
    const spec = generateOpenAPISpec(jwtSpec)
    expect(spec.paths['/auth/register']?.['post']).toBeDefined()
    expect(spec.paths['/auth/login']?.['post']).toBeDefined()
    expect(spec.paths['/auth/refresh']?.['post']).toBeDefined()
    expect(spec.paths['/auth/logout']?.['post']).toBeDefined()
    expect(spec.paths['/auth/me']?.['get']).toBeDefined()
    expect(spec.components.schemas['AuthUser']).toBeDefined()
  })

  it('marks token endpoints public but /auth/me bearer-protected', () => {
    const spec = generateOpenAPISpec(jwtSpec)
    // login/register must be reachable without a token (you have none yet)
    expect((spec.paths['/auth/login']?.['post'] as { security: unknown }).security).toEqual([])
    expect((spec.paths['/auth/register']?.['post'] as { security: unknown }).security).toEqual([])
    // /auth/me identifies the caller → requires the bearer token
    expect((spec.paths['/auth/me']?.['get'] as { security: unknown }).security).toEqual([
      { bearerAuth: [] },
    ])
  })

  it('adds an Auth tag when the JWT system is on', () => {
    const spec = generateOpenAPISpec(jwtSpec)
    expect(spec.tags?.some((t) => t.name === 'Auth')).toBe(true)
  })

  it('does NOT emit /auth/* paths when auth.jwt.enabled is absent', () => {
    // Legacy bearer mode validates externally-issued tokens — no user system.
    const legacy: ZeroAPISpec = {
      ...jwtSpec,
      auth: { strategy: 'jwt', secret: 'x'.repeat(32) },
    }
    const spec = generateOpenAPISpec(legacy)
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/auth'))).toBe(false)
  })

  it('emits the OAuth paths when providers are configured', () => {
    const oauthSpec: ZeroAPISpec = {
      ...jwtSpec,
      auth: {
        enabled: true,
        strategies: ['jwt', 'oauth'],
        jwt: { enabled: true },
        oauth: { providers: [{ name: 'google', clientIdEnv: 'G_ID', clientSecretEnv: 'G_SECRET' }] },
      },
    }
    const spec = generateOpenAPISpec(oauthSpec)
    expect(spec.paths['/auth/oauth/{provider}']?.['get']).toBeDefined()
    expect(spec.paths['/auth/oauth/{provider}/callback']?.['get']).toBeDefined()
    expect(spec.tags?.some((t) => t.name === 'OAuth')).toBe(true)
  })

  it('emits the API-key admin paths when apikey auth is enabled', () => {
    const apikeySpec: ZeroAPISpec = {
      ...jwtSpec,
      auth: { enabled: true, strategies: ['apikey'], apikey: { enabled: true } },
    }
    const spec = generateOpenAPISpec(apikeySpec)
    expect(spec.paths['/admin/api-keys']?.['post']).toBeDefined()
    expect(spec.paths['/admin/api-keys']?.['get']).toBeDefined()
    expect(spec.paths['/admin/api-keys/{id}']?.['delete']).toBeDefined()
    expect(spec.components.schemas['AdminApiKey']).toBeDefined()
  })

  it('emits no auth paths when the spec has no auth', () => {
    const spec = generateOpenAPISpec(sampleSpec)
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/auth'))).toBe(false)
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/admin'))).toBe(false)
  })
})
