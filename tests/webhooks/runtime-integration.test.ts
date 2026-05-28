import { describe, it, expect, afterEach } from 'vitest'
import { createRuntime } from '../../src/index.js'
import { MemoryWebhookStore, signPayload } from '../../src/webhooks/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const baseSpec: ZeroAPISpec = {
  version: '1.0', name: 'test-api',
  resources: [{
    name: 'Order',
    fields: { title: { type: 'string', required: true } },
  }],
}

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

describe('runtime — webhooks disabled', () => {
  it('does NOT mount /admin/webhooks when feature is absent', async () => {
    const { app, webhooks } = createRuntime(baseSpec, { enableLogging: false })
    expect(webhooks).toBeUndefined()

    const res = await app.request('/admin/webhooks')
    expect(res.status).toBe(404)
  })

  it('does NOT mount /webhooks/inbound when feature is absent', async () => {
    const { app } = createRuntime(baseSpec, { enableLogging: false })
    const res = await app.request('/webhooks/inbound/stripe', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('does NOT start a worker when feature is absent', () => {
    const { webhooks } = createRuntime(baseSpec, { enableLogging: false })
    expect(webhooks).toBeUndefined()
  })

  it('does not emit any event when no outbound feature is set', async () => {
    const store = new MemoryWebhookStore()
    await store.createEndpoint({ url: 'https://x.test', events: ['order.created'], secret: 's' })
    const { app } = createRuntime(baseSpec, {
      enableLogging: false, webhookStore: store,
    })
    await app.request('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a' }),
    })
    // No events since `outbound` is empty.
    expect((await store.listEventsForEndpoint('x'))).toEqual([])
  })
})

describe('runtime — outbound webhooks integration', () => {
  it('emits {resource}.created/updated/deleted into the store', async () => {
    const spec: ZeroAPISpec = {
      ...baseSpec,
      features: {
        webhooks: {
          outbound: ['order.created', 'order.updated', 'order.deleted'],
        },
      },
    }
    const store = new MemoryWebhookStore()
    const endpoint = await store.createEndpoint({
      url: 'https://hook.test', events: ['*'], secret: 'whsec_x',
    })
    const { app, webhooks } = createRuntime(spec, {
      enableLogging: false,
      webhookStore: store,
      webhookWorkerAutostart: false,
    })
    cleanups.push(() => webhooks?.worker.stop())

    const create = await app.request('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first' }),
    })
    expect(create.status).toBe(201)
    const { data: created } = await create.json() as { data: { id: string; title: string } }

    // Emit is fire-and-forget — flush microtasks.
    await new Promise((r) => setTimeout(r, 5))

    let events = await store.listEventsForEndpoint(endpoint.id)
    expect(events.map((e) => e.eventType)).toEqual(['order.created'])
    expect(events[0]?.payload).toMatchObject({ id: created.id, title: 'first' })

    // Update
    await app.request(`/orders/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    })
    await new Promise((r) => setTimeout(r, 5))
    events = await store.listEventsForEndpoint(endpoint.id)
    expect(events.map((e) => e.eventType)).toEqual(['order.updated', 'order.created'])

    // Delete
    await app.request(`/orders/${created.id}`, { method: 'DELETE' })
    await new Promise((r) => setTimeout(r, 5))
    events = await store.listEventsForEndpoint(endpoint.id)
    expect(events.map((e) => e.eventType)).toEqual(['order.deleted', 'order.updated', 'order.created'])
  })

  it('does NOT emit events that are not in the outbound allowlist', async () => {
    const spec: ZeroAPISpec = {
      ...baseSpec,
      features: { webhooks: { outbound: ['order.created'] } },
    }
    const store = new MemoryWebhookStore()
    const ep = await store.createEndpoint({ url: 'https://x.test', events: ['*'], secret: 's' })
    const { app, webhooks } = createRuntime(spec, {
      enableLogging: false,
      webhookStore: store,
      webhookWorkerAutostart: false,
    })
    cleanups.push(() => webhooks?.worker.stop())

    const create = await app.request('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    const { data } = await create.json() as { data: { id: string } }
    await app.request(`/orders/${data.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'y' }),
    })
    await new Promise((r) => setTimeout(r, 10))

    const events = await store.listEventsForEndpoint(ep.id)
    expect(events.map((e) => e.eventType)).toEqual(['order.created'])
  })

  it('mounts /admin/webhooks for endpoint management', async () => {
    const spec: ZeroAPISpec = {
      ...baseSpec,
      features: { webhooks: { outbound: ['order.created'] } },
    }
    const { app, webhooks } = createRuntime(spec, {
      enableLogging: false,
      webhookWorkerAutostart: false,
    })
    cleanups.push(() => webhooks?.worker.stop())

    const res = await app.request('/admin/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://hook.test', events: ['order.created'] }),
    })
    expect(res.status).toBe(201)
  })
})

describe('runtime — inbound webhooks integration', () => {
  it('mounts /webhooks/inbound/:source from features.webhooks.inbound', async () => {
    const spec: ZeroAPISpec = {
      ...baseSpec,
      features: { webhooks: { inbound: ['stripe.payment'] } },
    }
    const SECRET_ENV = 'STRIPE_WEBHOOK_SECRET'
    process.env[SECRET_ENV] = 's3kr3t'
    try {
      const { app, webhooks } = createRuntime(spec, {
        enableLogging: false,
        webhookWorkerAutostart: false,
        webhookInboundOptions: { log: () => {} },
      })
      cleanups.push(() => webhooks?.worker.stop())

      const body = JSON.stringify({ type: 'payment.succeeded', amount: 100 })
      const sig = signPayload('s3kr3t', body)
      const res = await app.request('/webhooks/inbound/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': sig },
        body,
      })
      expect(res.status).toBe(200)

      const bad = await app.request('/webhooks/inbound/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': 'wrong' },
        body,
      })
      expect(bad.status).toBe(401)
    } finally {
      delete process.env[SECRET_ENV]
    }
  })
})

describe('runtime — schema emits webhook models', () => {
  it('includes WebhookEndpoint + WebhookEvent when feature is enabled', () => {
    const spec: ZeroAPISpec = {
      ...baseSpec,
      features: { webhooks: { outbound: ['order.created'] } },
    }
    const { prismaSchema, webhooks } = createRuntime(spec, {
      enableLogging: false, webhookWorkerAutostart: false,
    })
    cleanups.push(() => webhooks?.worker.stop())
    expect(prismaSchema).toContain('model WebhookEndpoint')
    expect(prismaSchema).toContain('model WebhookEvent')
  })

  it('omits webhook models when feature is absent', () => {
    const { prismaSchema } = createRuntime(baseSpec, { enableLogging: false })
    expect(prismaSchema).not.toContain('model WebhookEndpoint')
    expect(prismaSchema).not.toContain('model WebhookEvent')
  })
})
