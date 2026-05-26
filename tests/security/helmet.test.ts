import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createHelmetMiddleware } from '../../src/security/helmet.js'

function makeApp(config = {}) {
  const app = new Hono()
  app.use('*', createHelmetMiddleware(config))
  app.get('/', (c) => c.text('ok'))
  return app
}

describe('createHelmetMiddleware', () => {
  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await makeApp().request('/')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('sets X-Frame-Options: DENY by default', async () => {
    const res = await makeApp().request('/')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('sets X-Frame-Options: SAMEORIGIN when configured', async () => {
    const res = await makeApp({ frameguard: 'SAMEORIGIN' as const }).request('/')
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  it('sets Strict-Transport-Security when hsts is enabled', async () => {
    const res = await makeApp().request('/')
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=')
  })

  it('omits HSTS when hsts is disabled', async () => {
    const res = await makeApp({ hsts: false }).request('/')
    expect(res.headers.get('Strict-Transport-Security')).toBeNull()
  })

  it('sets Content-Security-Policy by default', async () => {
    const res = await makeApp().request('/')
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy()
  })

  it('sets Referrer-Policy header', async () => {
    const res = await makeApp().request('/')
    expect(res.headers.get('Referrer-Policy')).toBeTruthy()
  })

  it('sets X-Powered-By: ZeroAPI', async () => {
    const res = await makeApp().request('/')
    expect(res.headers.get('X-Powered-By')).toBe('ZeroAPI')
  })

  it('sets Permissions-Policy header', async () => {
    const res = await makeApp().request('/')
    expect(res.headers.get('Permissions-Policy')).toBeTruthy()
  })
})
