import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateEnv, assertEnv } from '../../src/env/validate.js'
import { createRuntime } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const baseSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'env-test',
  resources: [],
}

const opts = {
  enableLogging: false, enableDocs: false,
  enableHelmet: false, enableCors: false, enableSanitize: false,
}

// ── validateEnv ───────────────────────────────────────────────────────────────

describe('validateEnv', () => {
  it('returns valid:true when requiredEnv is empty', () => {
    const result = validateEnv({ ...baseSpec, requiredEnv: [] })
    expect(result.valid).toBe(true)
    expect(result.missing).toHaveLength(0)
  })

  it('returns valid:true when a required var is set', () => {
    process.env['ZERO_TEST_VAR'] = 'hello'
    const result = validateEnv({ ...baseSpec, requiredEnv: ['ZERO_TEST_VAR'] })
    expect(result.valid).toBe(true)
    expect(result.missing).toHaveLength(0)
    delete process.env['ZERO_TEST_VAR']
  })

  it('returns valid:false with the var name when a required var is missing', () => {
    delete process.env['ZERO_MISSING_VAR']
    const result = validateEnv({ ...baseSpec, requiredEnv: ['ZERO_MISSING_VAR'] })
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('ZERO_MISSING_VAR')
  })

  it('reports all missing vars — not just the first one', () => {
    delete process.env['ZERO_MISS_A']
    delete process.env['ZERO_MISS_B']
    const result = validateEnv({ ...baseSpec, requiredEnv: ['ZERO_MISS_A', 'ZERO_MISS_B'] })
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('ZERO_MISS_A')
    expect(result.missing).toContain('ZERO_MISS_B')
    expect(result.missing).toHaveLength(2)
  })

  it('JWT auth without spec.auth.secret and without JWT_SECRET env → invalid', () => {
    delete process.env['JWT_SECRET']
    const result = validateEnv({
      ...baseSpec,
      auth: { strategy: 'jwt' },
    })
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('JWT_SECRET')
  })

  it('JWT auth with spec.auth.secret → valid (env not needed)', () => {
    delete process.env['JWT_SECRET']
    const result = validateEnv({
      ...baseSpec,
      auth: { strategy: 'jwt', secret: 'my-inline-secret' },
    })
    expect(result.valid).toBe(true)
  })

  it('JWT auth with JWT_SECRET env → valid (spec.auth.secret not needed)', () => {
    process.env['JWT_SECRET'] = 'from-env'
    const result = validateEnv({
      ...baseSpec,
      auth: { strategy: 'jwt' },
    })
    expect(result.valid).toBe(true)
    delete process.env['JWT_SECRET']
  })

  it('apikey strategy without JWT_SECRET → valid (no JWT requirement)', () => {
    delete process.env['JWT_SECRET']
    const result = validateEnv({
      ...baseSpec,
      auth: { strategy: 'apikey' },
    })
    expect(result.valid).toBe(true)
  })
})

// ── assertEnv ─────────────────────────────────────────────────────────────────

describe('assertEnv', () => {
  it('does not throw when all vars are set', () => {
    process.env['ZERO_PRESENT'] = 'yes'
    expect(() => assertEnv({ ...baseSpec, requiredEnv: ['ZERO_PRESENT'] })).not.toThrow()
    delete process.env['ZERO_PRESENT']
  })

  it('throws when a required var is missing', () => {
    delete process.env['ZERO_ABSENT']
    expect(() => assertEnv({ ...baseSpec, requiredEnv: ['ZERO_ABSENT'] }))
      .toThrow(/ZERO_ABSENT/)
  })

  it('error message lists all missing vars', () => {
    delete process.env['ZERO_X']
    delete process.env['ZERO_Y']
    let message = ''
    try { assertEnv({ ...baseSpec, requiredEnv: ['ZERO_X', 'ZERO_Y'] }) }
    catch (e) { message = (e as Error).message }
    expect(message).toContain('ZERO_X')
    expect(message).toContain('ZERO_Y')
  })
})

// ── createRuntime with validateEnv ────────────────────────────────────────────

describe('createRuntime validateEnv option', () => {
  it('does not throw when validateEnv is false (default) even with missing vars', () => {
    delete process.env['ZERO_REQUIRED']
    expect(() =>
      createRuntime({ ...baseSpec, requiredEnv: ['ZERO_REQUIRED'] }, { ...opts })
    ).not.toThrow()
  })

  it('throws at startup when validateEnv:true and a required var is missing', () => {
    delete process.env['ZERO_STARTUP_VAR']
    expect(() =>
      createRuntime(
        { ...baseSpec, requiredEnv: ['ZERO_STARTUP_VAR'] },
        { ...opts, validateEnv: true }
      )
    ).toThrow(/ZERO_STARTUP_VAR/)
  })

  it('does not throw when validateEnv:true and all vars are present', () => {
    process.env['ZERO_OK_VAR'] = 'value'
    expect(() =>
      createRuntime(
        { ...baseSpec, requiredEnv: ['ZERO_OK_VAR'] },
        { ...opts, validateEnv: true }
      )
    ).not.toThrow()
    delete process.env['ZERO_OK_VAR']
  })
})
