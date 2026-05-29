import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createSanitizeMiddleware } from '../../src/security/sanitize.js'

function makeApp() {
  const app = new Hono()
  app.use('*', createSanitizeMiddleware())
  app.post('/data', async (c) => {
    const body = await c.req.json() as Record<string, unknown>
    return c.json({ received: body })
  })
  app.get('/search', (c) => c.json({ q: c.req.query('q') }))
  return app
}

describe('createSanitizeMiddleware', () => {
  it('passes through safe JSON body', async () => {
    const res = await makeApp().request('/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
    })
    expect(res.status).toBe(200)
  })

  it('blocks XSS script tag in body', async () => {
    const res = await makeApp().request('/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '<script>alert(1)</script>' }),
    })
    expect(res.status).toBe(400)
  })

  it('blocks javascript: protocol in body', async () => {
    const res = await makeApp().request('/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'javascript:void(0)' }),
    })
    expect(res.status).toBe(400)
  })

  it('blocks SQL injection UNION SELECT in body', async () => {
    const res = await makeApp().request('/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'UNION SELECT * FROM users' }),
    })
    expect(res.status).toBe(400)
  })

  it('blocks XSS in query parameter', async () => {
    const res = await makeApp().request('/search?q=<script>alert(1)</script>')
    expect(res.status).toBe(400)
  })

  it('passes through GET requests without body', async () => {
    const res = await makeApp().request('/search?q=hello+world')
    expect(res.status).toBe(200)
  })

  it('allows normal content with HTML-like text in non-script context', async () => {
    const res = await makeApp().request('/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Price > 100 and age < 50' }),
    })
    expect(res.status).toBe(200)
  })
})
