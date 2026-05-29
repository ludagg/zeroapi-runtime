import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createRateLimitMiddleware } from '../../src/security/ratelimit.js'
import type { RateLimitConfig } from '../../src/types/spec.js'

function makeApp(config: RateLimitConfig) {
  const app = new Hono()
  app.use('*', createRateLimitMiddleware(config))
  app.get('/', (c) => c.text('ok'))
  return app
}

describe('createRateLimitMiddleware', () => {
  it('allows requests under the limit', async () => {
    const app = makeApp({ windowMs: 60_000, max: 5 })
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })

  it('returns 429 when limit is exceeded', async () => {
    const app = makeApp({ windowMs: 60_000, max: 3 })
    // Make max requests to exhaust the limit
    await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } })
    await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } })
    await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } })
    const res = await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } })
    expect(res.status).toBe(429)
  })

  it('429 response includes retryAfter', async () => {
    const app = makeApp({ windowMs: 30_000, max: 1 })
    await app.request('/', { headers: { 'x-forwarded-for': '9.9.9.9' } })
    const res = await app.request('/', { headers: { 'x-forwarded-for': '9.9.9.9' } })
    const body = await res.json() as { retryAfter: number }
    expect(body.retryAfter).toBe(30)
  })

  it('different IPs have independent counters', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1 })
    await app.request('/', { headers: { 'x-forwarded-for': '10.0.0.1' } })
    const res = await app.request('/', { headers: { 'x-forwarded-for': '10.0.0.2' } })
    expect(res.status).toBe(200)
  })

  it('uses custom message when provided', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, message: 'Slow down!' })
    await app.request('/', { headers: { 'x-forwarded-for': '5.5.5.5' } })
    const res = await app.request('/', { headers: { 'x-forwarded-for': '5.5.5.5' } })
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Slow down!')
  })

  it('allows high traffic from different IPs simultaneously', async () => {
    const app = makeApp({ windowMs: 60_000, max: 10 })
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.request('/', { headers: { 'x-forwarded-for': `192.168.0.${i + 1}` } })
      )
    )
    for (const res of results) {
      expect(res.status).toBe(200)
    }
  })
})
