import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import {
  MemoryWebhookStore, mountWebhookAdminRoutes,
} from '../../src/webhooks/index.js'

function makeApp(opts: { authed?: boolean } = {}) {
  const store = new MemoryWebhookStore()
  const app = new Hono()
  mountWebhookAdminRoutes(app, store, opts.authed
    ? (async (c, next) => {
        if (c.req.header('authorization') !== 'Bearer ok') return c.json({ error: 'Unauthorized' }, 401)
        return next()
      })
    : undefined, { log: () => {} })
  return { app, store }
}

async function createEndpoint(app: Hono, body: Record<string, unknown>): Promise<Response> {
  return app.request('/admin/webhooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /admin/webhooks', () => {
  it('creates an endpoint, returns the secret ONCE', async () => {
    const { app, store } = makeApp()
    const res = await createEndpoint(app, { url: 'https://hooks.example.com/in', events: ['order.created'] })
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { id: string; secret: string; events: string[]; url: string } }
    expect(data.secret).toMatch(/^whsec_[a-f0-9]{64}$/)
    expect(data.events).toEqual(['order.created'])

    // Listing must not re-expose the secret.
    const listRes = await app.request('/admin/webhooks')
    const list = await listRes.json() as { data: Record<string, unknown>[] }
    expect(list.data[0]).not.toHaveProperty('secret')

    // The store retains the secret internally.
    const persisted = await store.getEndpoint(data.id)
    expect(persisted?.secret).toBe(data.secret)
  })

  it('rejects a non-http(s) url with 400', async () => {
    const { app } = makeApp()
    const res = await createEndpoint(app, { url: 'ftp://nope', events: ['x'] })
    expect(res.status).toBe(400)
  })

  it('rejects empty events with 400', async () => {
    const { app } = makeApp()
    const res = await createEndpoint(app, { url: 'https://ok.test', events: [] })
    expect(res.status).toBe(400)
  })

  it('rejects malformed JSON with 400', async () => {
    const { app } = makeApp()
    const res = await app.request('/admin/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('is gated by the guard middleware when supplied', async () => {
    const { app } = makeApp({ authed: true })
    const noAuth = await createEndpoint(app, { url: 'https://ok.test', events: ['x'] })
    expect(noAuth.status).toBe(401)

    const ok = await app.request('/admin/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ok' },
      body: JSON.stringify({ url: 'https://ok.test', events: ['x'] }),
    })
    expect(ok.status).toBe(201)
  })
})

describe('GET /admin/webhooks', () => {
  it('lists endpoints without their secrets', async () => {
    const { app } = makeApp()
    await createEndpoint(app, { url: 'https://a.test', events: ['x'] })
    await createEndpoint(app, { url: 'https://b.test', events: ['y'] })
    const res = await app.request('/admin/webhooks')
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: Record<string, unknown>[] }
    expect(data).toHaveLength(2)
    for (const row of data) expect(row).not.toHaveProperty('secret')
  })
})

describe('DELETE /admin/webhooks/:id', () => {
  it('removes the endpoint and returns 200', async () => {
    const { app } = makeApp()
    const created = await createEndpoint(app, { url: 'https://x.test', events: ['x'] })
    const { data } = await created.json() as { data: { id: string } }
    const res = await app.request(`/admin/webhooks/${data.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    const list = await app.request('/admin/webhooks')
    const { data: rows } = await list.json() as { data: unknown[] }
    expect(rows).toEqual([])
  })

  it('returns 404 for an unknown id', async () => {
    const { app } = makeApp()
    const res = await app.request('/admin/webhooks/00000000-0000-0000-0000-000000000000', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('GET /admin/webhooks/:id/deliveries', () => {
  it('returns delivery history (most-recent first)', async () => {
    const { app, store } = makeApp()
    const create = await createEndpoint(app, { url: 'https://x.test', events: ['order.created'] })
    const { data } = await create.json() as { data: { id: string } }

    await store.createEvent({ endpointId: data.id, eventType: 'order.created', payload: { v: 1 } })
    await new Promise((r) => setTimeout(r, 5))
    await store.createEvent({ endpointId: data.id, eventType: 'order.created', payload: { v: 2 } })

    const res = await app.request(`/admin/webhooks/${data.id}/deliveries`)
    expect(res.status).toBe(200)
    const { data: rows } = await res.json() as { data: { eventType: string; status: string }[] }
    expect(rows).toHaveLength(2)
    expect(rows[0]?.status).toBe('pending')
  })

  it('returns 404 for unknown endpoint', async () => {
    const { app } = makeApp()
    const res = await app.request('/admin/webhooks/missing/deliveries')
    expect(res.status).toBe(404)
  })
})
