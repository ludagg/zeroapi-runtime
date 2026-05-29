import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import {
  mountWebhookInboundRoutes, InboundEventLog,
  signPayload,
} from '../../src/webhooks/index.js'

const SECRET_ENV = 'STRIPE_WEBHOOK_SECRET'

function makeApp(opts: { onEvent?: (r: import('../../src/webhooks/index.js').InboundEventRecord) => void } = {}) {
  const eventLog = new InboundEventLog()
  const app = new Hono()
  mountWebhookInboundRoutes(app, [
    { source: 'stripe', secretEnv: SECRET_ENV },
  ], {
    eventLog,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    log: () => {},
  })
  return { app, eventLog }
}

beforeEach(() => { delete process.env[SECRET_ENV] })
afterEach(() => { delete process.env[SECRET_ENV] })

describe('POST /webhooks/inbound/:source', () => {
  it('accepts a request with the correct signature', async () => {
    process.env[SECRET_ENV] = 'secret'
    const { app, eventLog } = makeApp()
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' })
    const sig = signPayload('secret', body)

    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sig },
      body,
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean; id: string }
    expect(json.received).toBe(true)
    expect(json.id).toBeDefined()

    const recent = eventLog.recent('stripe')
    expect(recent).toHaveLength(1)
    expect(recent[0]?.payload).toEqual({ id: 'evt_1', type: 'payment.succeeded' })
  })

  it('rejects a bad signature with 401', async () => {
    process.env[SECRET_ENV] = 'secret'
    const { app, eventLog } = makeApp()
    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': 'deadbeef' },
      body: JSON.stringify({ id: 'evt' }),
    })
    expect(res.status).toBe(401)
    expect(eventLog.recent('stripe')).toHaveLength(0)
  })

  it('rejects when signature header is missing AND a secret is configured', async () => {
    process.env[SECRET_ENV] = 'secret'
    const { app } = makeApp()
    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('accepts without verification when no secret is configured (dev mode)', async () => {
    const { app } = makeApp()  // secret env unset
    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
  })

  it('returns 404 for an unknown source', async () => {
    const { app } = makeApp()
    const res = await app.request('/webhooks/inbound/unknown', { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  it('supports a custom signature header + extractor (Stripe-style)', async () => {
    process.env['CUSTOM_WEBHOOK_SECRET'] = 'sk'
    const app = new Hono()
    mountWebhookInboundRoutes(app, [{
      source: 'custom',
      secretEnv: 'CUSTOM_WEBHOOK_SECRET',
      signatureHeader: 'stripe-signature',
      extractSignature: (raw) => {
        const parts = raw.split(',').map((p) => p.trim())
        const v1 = parts.find((p) => p.startsWith('v1='))
        return v1 ? v1.slice(3) : null
      },
    }], { log: () => {} })

    const body = '{"x":1}'
    const sig = signPayload('sk', body)
    const res = await app.request('/webhooks/inbound/custom', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=12345,v1=${sig}` },
      body,
    })
    expect(res.status).toBe(200)

    delete process.env['CUSTOM_WEBHOOK_SECRET']
  })

  it('invokes onEvent for accepted events', async () => {
    process.env[SECRET_ENV] = 's'
    const events: unknown[] = []
    const { app } = makeApp({ onEvent: (r) => { events.push(r.payload) } })
    const body = JSON.stringify({ hi: 'there' })
    const sig = signPayload('s', body)
    const res = await app.request('/webhooks/inbound/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': sig },
      body,
    })
    expect(res.status).toBe(200)
    // onEvent runs after response — give it a microtask tick.
    await new Promise((r) => setTimeout(r, 5))
    expect(events).toEqual([{ hi: 'there' }])
  })
})
