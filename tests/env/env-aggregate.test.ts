import { describe, it, expect } from 'vitest'
import { getRequiredEnvVars } from '../../src/env/aggregate.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const baseSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'agg-test',
  resources: [],
}

describe('getRequiredEnvVars — explicit block', () => {
  it('returns explicit env vars first, in order', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      env: [
        { name: 'STRIPE_KEY', required: false, description: 'Stripe key' },
        { name: 'SENTRY_DSN', required: true },
      ],
    })
    expect(vars[0]?.name).toBe('STRIPE_KEY')
    expect(vars[0]?.source).toBe('explicit')
    expect(vars[0]?.description).toBe('Stripe key')
    expect(vars[1]?.name).toBe('SENTRY_DSN')
    expect(vars[1]?.source).toBe('explicit')
  })

  it('preserves generate / managedByCloud / example fields', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      env: [
        {
          name: 'API_TOKEN',
          required: true,
          generate: true,
          managedByCloud: true,
          example: 'tok_abc',
        },
      ],
    })
    expect(vars[0]?.generate).toBe(true)
    expect(vars[0]?.managedByCloud).toBe(true)
    expect(vars[0]?.example).toBe('tok_abc')
  })

  it('returns an empty-but-for-database list when no env block and no features', () => {
    const vars = getRequiredEnvVars(baseSpec)
    expect(vars.map((v) => v.name)).toEqual(['DATABASE_URL'])
    expect(vars[0]?.source).toBe('database')
  })
})

describe('getRequiredEnvVars — implicit JWT', () => {
  it('adds JWT_SECRET when auth.jwt.enabled is true', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      auth: { jwt: { enabled: true } },
    })
    const jwt = vars.find((v) => v.name === 'JWT_SECRET')
    expect(jwt).toBeDefined()
    expect(jwt?.source).toBe('auth.jwt')
    expect(jwt?.generate).toBe(true)
    expect(jwt?.required).toBe(true)
  })

  it('uses custom secretEnv name when configured', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      auth: { jwt: { enabled: true, secretEnv: 'MY_TOKEN' } },
    })
    expect(vars.some((v) => v.name === 'MY_TOKEN')).toBe(true)
    expect(vars.some((v) => v.name === 'JWT_SECRET')).toBe(false)
  })

  it('also handles legacy auth.strategy === "jwt"', () => {
    const vars = getRequiredEnvVars({ ...baseSpec, auth: { strategy: 'jwt' } })
    expect(vars.some((v) => v.name === 'JWT_SECRET' && v.source === 'auth.jwt')).toBe(true)
  })
})

describe('getRequiredEnvVars — implicit OAuth', () => {
  it('adds OAUTH_CALLBACK_BASE_URL + provider creds per configured provider', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      auth: {
        oauth: {
          providers: [
            { name: 'google', clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' },
          ],
        },
      },
    })
    const names = vars.map((v) => v.name)
    expect(names).toContain('OAUTH_CALLBACK_BASE_URL')
    expect(names).toContain('GOOGLE_CLIENT_ID')
    expect(names).toContain('GOOGLE_CLIENT_SECRET')
    expect(vars.find((v) => v.name === 'GOOGLE_CLIENT_ID')?.source).toBe('auth.oauth')
  })
})

describe('getRequiredEnvVars — implicit file upload', () => {
  it('adds S3 vars when fileUpload provider is s3', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      features: { fileUpload: { enabled: true, provider: 's3', maxSizeMB: 5, allowedTypes: [] } },
    })
    const names = vars.map((v) => v.name)
    expect(names).toContain('AWS_ACCESS_KEY_ID')
    expect(names).toContain('AWS_SECRET_ACCESS_KEY')
    expect(names).toContain('AWS_REGION')
    expect(names).toContain('AWS_BUCKET')
    expect(names).not.toContain('R2_ENDPOINT')
  })

  it('adds R2_ENDPOINT in addition to S3 vars when provider is r2', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      features: { fileUpload: { enabled: true, provider: 'r2', maxSizeMB: 5, allowedTypes: [] } },
    })
    expect(vars.map((v) => v.name)).toContain('R2_ENDPOINT')
  })

  it('does not add S3 vars when provider is local', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      features: { fileUpload: { enabled: true, provider: 'local', maxSizeMB: 5, allowedTypes: [] } },
    })
    expect(vars.map((v) => v.name)).not.toContain('AWS_ACCESS_KEY_ID')
  })
})

describe('getRequiredEnvVars — merging', () => {
  it('explicit declarations take precedence over implicit ones (no duplicates)', () => {
    const vars = getRequiredEnvVars({
      ...baseSpec,
      auth: { jwt: { enabled: true } },
      env: [
        { name: 'JWT_SECRET', required: true, description: 'My own JWT secret', generate: false },
      ],
    })
    const jwtVars = vars.filter((v) => v.name === 'JWT_SECRET')
    expect(jwtVars).toHaveLength(1)
    expect(jwtVars[0]?.source).toBe('explicit')
    expect(jwtVars[0]?.description).toBe('My own JWT secret')
    expect(jwtVars[0]?.generate).toBe(false)
  })

  it('always exposes DATABASE_URL', () => {
    expect(getRequiredEnvVars(baseSpec).some((v) => v.name === 'DATABASE_URL')).toBe(true)
    expect(
      getRequiredEnvVars({ ...baseSpec, auth: { jwt: { enabled: true } } })
        .some((v) => v.name === 'DATABASE_URL'),
    ).toBe(true)
  })
})
