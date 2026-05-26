import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createRuntime } from '../../src/index.js'
import { createLogger } from '../../src/observability/logger.js'
import { createRequestIdMiddleware } from '../../src/observability/requestId.js'
import { minimalSpec } from '../fixtures/sample-spec.js'

const opts = {
  enableLogging: false, enableDocs: false,
  enableHelmet: false, enableCors: false, enableSanitize: false,
}

// ── Request ID middleware ─────────────────────────────────────────────────────

describe('Request ID middleware', () => {
  it('adds x-request-id header to all responses', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const res = await app.request('/health')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('generated request ID matches UUID format', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const res = await app.request('/health')
    const id = res.headers.get('x-request-id') ?? ''
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('propagates client-provided x-request-id unchanged', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const res = await app.request('/health', {
      headers: { 'x-request-id': 'custom-trace-abc-123' },
    })
    expect(res.headers.get('x-request-id')).toBe('custom-trace-abc-123')
  })

  it('two concurrent requests get different IDs', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const [r1, r2] = await Promise.all([
      app.request('/health'),
      app.request('/health'),
    ])
    const id1 = r1.headers.get('x-request-id')
    const id2 = r2.headers.get('x-request-id')
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })

  it('standalone middleware sets x-request-id on a plain Hono app', async () => {
    const app = new Hono()
    app.use('*', createRequestIdMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })
})

// ── /health endpoint ──────────────────────────────────────────────────────────

describe('/health endpoint', () => {
  it('returns status: ok', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const body = await (await app.request('/health')).json() as { status: string }
    expect(body.status).toBe('ok')
  })

  it('returns name and version from spec', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const body = await (await app.request('/health')).json() as { name: string; version: string }
    expect(body.name).toBe(minimalSpec.name)
    expect(body.version).toBe(minimalSpec.version)
  })

  it('includes uptime field as a non-negative number', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const body = await (await app.request('/health')).json() as { uptime: number }
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  it('uptime increases over time', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const b1 = await (await app.request('/health')).json() as { uptime: number }
    await new Promise((r) => setTimeout(r, 1100))
    const b2 = await (await app.request('/health')).json() as { uptime: number }
    expect(b2.uptime).toBeGreaterThanOrEqual(b1.uptime)
  })
})

// ── /ready endpoint ───────────────────────────────────────────────────────────

describe('/ready endpoint', () => {
  it('returns HTTP 200', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const res = await app.request('/ready')
    expect(res.status).toBe(200)
  })

  it('returns status: ready', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const body = await (await app.request('/ready')).json() as { status: string }
    expect(body.status).toBe('ready')
  })

  it('includes timestamp in ISO 8601 format', async () => {
    const { app } = createRuntime(minimalSpec, opts)
    const body = await (await app.request('/ready')).json() as { timestamp: string }
    expect(() => new Date(body.timestamp)).not.toThrow()
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
  })
})

// ── createLogger ──────────────────────────────────────────────────────────────

describe('createLogger', () => {
  it('returns an object with debug, info, warn, error methods', () => {
    const logger = createLogger()
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })

  it('disabled logger does not write to stdout', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const logger = createLogger('debug', false)
    logger.info('should not appear')
    expect(writeSpy).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })

  it('info-level logger suppresses debug messages', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const logger = createLogger('info', true)
    logger.debug('hidden')
    expect(writeSpy).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })

  it('info-level logger emits info messages', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const logger = createLogger('info', true)
    logger.info('visible')
    expect(writeSpy).toHaveBeenCalledOnce()
    const written = writeSpy.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(written) as { level: string; message: string }
    expect(parsed.level).toBe('info')
    expect(parsed.message).toBe('visible')
    writeSpy.mockRestore()
  })

  it('error messages go to stderr not stdout', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const logger = createLogger('debug', true)
    logger.error('something broke')
    expect(stderrSpy).toHaveBeenCalled()
    expect(stdoutSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
  })

  it('log output includes timestamp, level, and message', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const logger = createLogger('debug', true)
    logger.warn('test-warning')
    // warn goes to stderr
    writeSpy.mockRestore()

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const l2 = createLogger('debug', true)
    l2.warn('check-structure', { requestId: 'abc' })
    const written = stderrSpy.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(written) as { timestamp: string; level: string; message: string; requestId: string }
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(parsed.level).toBe('warn')
    expect(parsed.message).toBe('check-structure')
    expect(parsed.requestId).toBe('abc')
    stderrSpy.mockRestore()
  })
})
