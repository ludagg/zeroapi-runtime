import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createCorsMiddleware } from '../../src/security/cors.js'
import type { CorsConfig } from '../../src/types/spec.js'

function makeApp(config?: CorsConfig) {
  const app = new Hono()
  app.use('*', createCorsMiddleware(config))
  app.get('/', (c) => c.text('ok'))
  return app
}

describe('createCorsMiddleware', () => {
  it('allows all origins by default (no config)', async () => {
    const res = await makeApp().request('/', {
      headers: { Origin: 'https://example.com' },
    })
    expect(res.status).toBe(200)
  })

  it('sets Access-Control-Allow-Origin for allowed origin', async () => {
    const config: CorsConfig = { origins: ['https://example.com'] }
    const res = await makeApp(config).request('/', {
      headers: { Origin: 'https://example.com' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
  })

  it('responds to OPTIONS preflight', async () => {
    const config: CorsConfig = { origins: ['https://example.com'] }
    const res = await makeApp(config).request('/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    })
    expect([200, 204]).toContain(res.status)
  })

  it('sets Access-Control-Allow-Headers', async () => {
    const config: CorsConfig = {
      origins: ['https://example.com'],
      headers: ['X-Custom-Header', 'Authorization'],
    }
    const res = await makeApp(config).request('/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET',
      },
    })
    const allowed = res.headers.get('Access-Control-Allow-Headers') ?? ''
    expect(allowed.toLowerCase()).toContain('x-custom-header')
  })

  it('sets credentials header when credentials is true', async () => {
    const config: CorsConfig = { origins: ['https://example.com'], credentials: true }
    const res = await makeApp(config).request('/', {
      headers: { Origin: 'https://example.com' },
    })
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })
})
