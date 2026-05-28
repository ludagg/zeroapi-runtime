import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateAndGenerateEnv, getConfigCheck } from '../../src/env/boot.js'
import { createRuntime } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const baseSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'boot-test',
  resources: [],
}

const opts = {
  enableLogging: false, enableDocs: false,
  enableHelmet: false, enableCors: false, enableSanitize: false,
}

// ── validateAndGenerateEnv ────────────────────────────────────────────────────

describe('validateAndGenerateEnv — generate:true', () => {
  const NAME = 'BOOT_GEN_SECRET'

  beforeEach(() => { delete process.env[NAME] })
  afterEach(() => { delete process.env[NAME] })

  it('generates a value when missing and writes it to process.env', () => {
    const lines: string[] = []
    const result = validateAndGenerateEnv(
      { ...baseSpec, env: [{ name: NAME, required: true, generate: true }] },
      { log: (l) => lines.push(l), isProduction: false },
    )
    expect(result.generated).toContain(NAME)
    expect(process.env[NAME]).toBeDefined()
    expect(process.env[NAME]?.length).toBeGreaterThan(20)
  })

  it('warns about the auto-generated value being ephemeral', () => {
    const lines: string[] = []
    validateAndGenerateEnv(
      { ...baseSpec, env: [{ name: NAME, required: true, generate: true }] },
      { log: (l) => lines.push(l), isProduction: false },
    )
    expect(lines.some((l) => l.includes(NAME) && l.includes('généré automatiquement'))).toBe(true)
  })

  it('leaves an existing value untouched', () => {
    process.env[NAME] = 'already-set'
    const result = validateAndGenerateEnv(
      { ...baseSpec, env: [{ name: NAME, required: true, generate: true }] },
      { log: () => {}, isProduction: false },
    )
    expect(result.generated).not.toContain(NAME)
    expect(process.env[NAME]).toBe('already-set')
  })
})

describe('validateAndGenerateEnv — required, no generate', () => {
  beforeEach(() => {
    delete process.env['BOOT_REQ_A']
    delete process.env['BOOT_REQ_B']
  })
  afterEach(() => {
    delete process.env['BOOT_REQ_A']
    delete process.env['BOOT_REQ_B']
  })

  it('throws in production with a clear message listing the var', () => {
    expect(() =>
      validateAndGenerateEnv(
        {
          ...baseSpec,
          env: [{ name: 'BOOT_REQ_A', required: true, description: 'Clé Stripe' }],
        },
        { log: () => {}, isProduction: true },
      ),
    ).toThrow(/BOOT_REQ_A/)
  })

  it('error message mentions production and includes descriptions', () => {
    let msg = ''
    try {
      validateAndGenerateEnv(
        {
          ...baseSpec,
          env: [{ name: 'BOOT_REQ_A', required: true, description: 'Clé Stripe pour paiements' }],
        },
        { log: () => {}, isProduction: true },
      )
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/production/i)
    expect(msg).toContain('BOOT_REQ_A')
    expect(msg).toContain('Clé Stripe pour paiements')
  })

  it('lists ALL missing vars in one go (no fail-on-first)', () => {
    let msg = ''
    try {
      validateAndGenerateEnv(
        {
          ...baseSpec,
          env: [
            { name: 'BOOT_REQ_A', required: true },
            { name: 'BOOT_REQ_B', required: true },
          ],
        },
        { log: () => {}, isProduction: true },
      )
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('BOOT_REQ_A')
    expect(msg).toContain('BOOT_REQ_B')
  })

  it('only warns in dev (no throw)', () => {
    const lines: string[] = []
    expect(() =>
      validateAndGenerateEnv(
        { ...baseSpec, env: [{ name: 'BOOT_REQ_A', required: true }] },
        { log: (l) => lines.push(l), isProduction: false },
      ),
    ).not.toThrow()
    expect(lines.some((l) => l.includes('BOOT_REQ_A'))).toBe(true)
  })

  it('does not touch optional vars', () => {
    const result = validateAndGenerateEnv(
      { ...baseSpec, env: [{ name: 'BOOT_REQ_A', required: false }] },
      { log: () => {}, isProduction: true },
    )
    expect(result.fatal).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })
})

describe('validateAndGenerateEnv — implicit vars are non-blocking', () => {
  it('does not fail in production when an implicit var (auth.jwt) is missing', () => {
    // Implicit JWT_SECRET keeps its dedicated `resolveJwtSecret` handling.
    delete process.env['JWT_SECRET']
    expect(() =>
      validateAndGenerateEnv(
        { ...baseSpec, auth: { jwt: { enabled: true } } },
        { log: () => {}, isProduction: true },
      ),
    ).not.toThrow()
  })

  it('does not auto-generate implicit JWT_SECRET (left to resolveJwtSecret)', () => {
    delete process.env['JWT_SECRET']
    const result = validateAndGenerateEnv(
      { ...baseSpec, auth: { jwt: { enabled: true } } },
      { log: () => {}, isProduction: false },
    )
    expect(result.generated).not.toContain('JWT_SECRET')
    expect(process.env['JWT_SECRET']).toBeUndefined()
  })
})

// ── getConfigCheck ────────────────────────────────────────────────────────────

describe('getConfigCheck', () => {
  beforeEach(() => {
    delete process.env['CFG_PRESENT']
    delete process.env['CFG_MISSING']
  })
  afterEach(() => {
    delete process.env['CFG_PRESENT']
    delete process.env['CFG_MISSING']
  })

  it('returns allRequiredPresent:true when every required var is set', () => {
    process.env['CFG_PRESENT'] = 'ok'
    process.env['DATABASE_URL'] = 'postgresql://x'
    const check = getConfigCheck({
      ...baseSpec,
      env: [{ name: 'CFG_PRESENT', required: true }],
    })
    expect(check.allRequiredPresent).toBe(true)
    expect(check.missing).toEqual([])
    delete process.env['DATABASE_URL']
  })

  it('returns missing names but never values', () => {
    process.env['CFG_PRESENT'] = 'secret-value'
    const check = getConfigCheck({
      ...baseSpec,
      env: [
        { name: 'CFG_PRESENT', required: true },
        { name: 'CFG_MISSING', required: true },
      ],
    })
    expect(check.missing).toContain('CFG_MISSING')
    expect(check.missing).not.toContain('CFG_PRESENT')
    expect(JSON.stringify(check)).not.toContain('secret-value')
  })

  it('ignores optional vars', () => {
    const check = getConfigCheck({
      ...baseSpec,
      env: [{ name: 'CFG_MISSING', required: false }],
    })
    expect(check.missing).not.toContain('CFG_MISSING')
  })

  it('reports a missing implicit var (e.g. JWT_SECRET) too', () => {
    delete process.env['JWT_SECRET']
    const check = getConfigCheck({ ...baseSpec, auth: { jwt: { enabled: true } } })
    expect(check.missing).toContain('JWT_SECRET')
    expect(check.allRequiredPresent).toBe(false)
  })
})

// ── /health endpoint integration ──────────────────────────────────────────────

describe('/health configCheck', () => {
  beforeEach(() => {
    delete process.env['HEALTH_REQ']
  })
  afterEach(() => {
    delete process.env['HEALTH_REQ']
  })

  it('exposes configCheck.allRequiredPresent:true when all set', async () => {
    process.env['HEALTH_REQ'] = 'value'
    process.env['DATABASE_URL'] = 'postgresql://x'
    const { app } = createRuntime(
      { ...baseSpec, env: [{ name: 'HEALTH_REQ', required: true }] },
      { ...opts, envBootLogger: () => {} },
    )
    const body = await (await app.request('/health')).json() as {
      configCheck: { allRequiredPresent: boolean; missing: string[] }
    }
    expect(body.configCheck.allRequiredPresent).toBe(true)
    expect(body.configCheck.missing).toEqual([])
    delete process.env['DATABASE_URL']
  })

  it('lists missing required vars by name in configCheck.missing', async () => {
    process.env['HEALTH_REQ'] = 'set'
    delete process.env['DATABASE_URL']
    const { app } = createRuntime(
      {
        ...baseSpec,
        env: [
          { name: 'HEALTH_REQ', required: true },
          { name: 'NOT_THERE', required: true },
        ],
      },
      { ...opts, envBootLogger: () => {} },
    )
    const body = await (await app.request('/health')).json() as {
      configCheck: { allRequiredPresent: boolean; missing: string[] }
    }
    expect(body.configCheck.allRequiredPresent).toBe(false)
    expect(body.configCheck.missing).toContain('NOT_THERE')
    expect(body.configCheck.missing).toContain('DATABASE_URL')
  })

  it('never exposes a variable value in the response', async () => {
    process.env['HEALTH_REQ'] = 'super-secret-shh'
    const { app } = createRuntime(
      { ...baseSpec, env: [{ name: 'HEALTH_REQ', required: true }] },
      { ...opts, envBootLogger: () => {} },
    )
    const raw = await (await app.request('/health')).text()
    expect(raw).not.toContain('super-secret-shh')
  })
})

// ── createRuntime auto-boot validation ────────────────────────────────────────

describe('createRuntime — Phase 3.1 auto boot validation', () => {
  const NAME = 'PHASE31_BOOT_VAR'
  const savedNodeEnv = process.env['NODE_ENV']

  beforeEach(() => { delete process.env[NAME] })
  afterEach(() => {
    delete process.env[NAME]
    if (savedNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = savedNodeEnv
  })

  it('refuses to start in production when an explicit required var is missing', () => {
    process.env['NODE_ENV'] = 'production'
    expect(() =>
      createRuntime(
        { ...baseSpec, env: [{ name: NAME, required: true, description: 'Indispensable' }] },
        { ...opts, envBootLogger: () => {} },
      ),
    ).toThrow(new RegExp(NAME))
  })

  it('only warns in dev when an explicit required var is missing', () => {
    delete process.env['NODE_ENV']
    const lines: string[] = []
    expect(() =>
      createRuntime(
        { ...baseSpec, env: [{ name: NAME, required: true }] },
        { ...opts, envBootLogger: (l) => lines.push(l) },
      ),
    ).not.toThrow()
    expect(lines.some((l) => l.includes(NAME))).toBe(true)
  })

  it('auto-generates and warns when generate:true and missing', () => {
    delete process.env['NODE_ENV']
    const lines: string[] = []
    createRuntime(
      { ...baseSpec, env: [{ name: NAME, required: true, generate: true }] },
      { ...opts, envBootLogger: (l) => lines.push(l) },
    )
    expect(process.env[NAME]).toBeDefined()
    expect(process.env[NAME]?.length).toBeGreaterThan(20)
    expect(lines.some((l) => l.includes(NAME) && l.includes('généré'))).toBe(true)
  })

  it('does not affect backward compat: empty spec + no env block boots clean', () => {
    delete process.env['NODE_ENV']
    expect(() => createRuntime(baseSpec, { ...opts, envBootLogger: () => {} })).not.toThrow()
  })
})
