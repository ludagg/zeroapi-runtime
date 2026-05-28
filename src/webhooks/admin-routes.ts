import type { Hono, MiddlewareHandler } from 'hono'
import type { WebhookStore } from './store.js'
import { generateWebhookSecret } from './signature.js'

export interface AdminRoutesOptions {
  /** Receives boot warnings (e.g. dangerous URLs). Defaults to `console.warn`. */
  log?: (line: string) => void
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

function isValidUrl(input: unknown): input is string {
  if (typeof input !== 'string' || input.length === 0) return false
  try {
    const u = new URL(input)
    return ALLOWED_PROTOCOLS.has(u.protocol)
  } catch {
    return false
  }
}

function isLikelyLocalhost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local')
    )
  } catch {
    return false
  }
}

function serializeEndpoint(record: {
  id: string; url: string; events: string; active: boolean; createdAt: Date
}): Record<string, unknown> {
  return {
    id: record.id,
    url: record.url,
    events: record.events.split(',').map((s) => s.trim()).filter(Boolean),
    active: record.active,
    createdAt: record.createdAt.toISOString(),
  }
}

/**
 * Mounts the admin webhook-management endpoints.
 *
 *   POST   /admin/webhooks                  → 201 { id, url, events, secret, ... }
 *                                             (secret returned ONCE)
 *   GET    /admin/webhooks                  → 200 { data: [...] } (no secret)
 *   DELETE /admin/webhooks/:id              → 200 { data: { id, deleted: true } }
 *   GET    /admin/webhooks/:id/deliveries   → 200 { data: [...events...] }
 *
 * All routes are gated by the supplied `guard` middleware when present.
 */
export function mountWebhookAdminRoutes(
  app: Hono,
  store: WebhookStore,
  guard?: MiddlewareHandler,
  options: AdminRoutesOptions = {},
): void {
  const log = options.log ?? ((line: string) => console.warn(line))

  const create = async (c: import('hono').Context) => {
    let body: Record<string, unknown>
    try { body = await c.req.json() as Record<string, unknown> }
    catch { return c.json({ error: 'Request body must be valid JSON' }, 400) }

    const url = body['url']
    const events = body['events']

    if (!isValidUrl(url)) return c.json({ error: 'Invalid url — must be http(s)' }, 400)
    if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string' && e.length > 0)) {
      return c.json({ error: 'events must be a non-empty array of strings' }, 400)
    }

    if (isLikelyLocalhost(url) && process.env['NODE_ENV'] === 'production') {
      log(`⚠️  webhook endpoint points at a local address (${url}) — deliveries will fail outside the host machine.`)
    }

    const secret = generateWebhookSecret()
    const record = await store.createEndpoint({
      url, events: events as string[], secret,
    })

    // Secret returned ONLY here — list/get omit it.
    return c.json({
      data: {
        ...serializeEndpoint(record),
        secret,
      },
    }, 201)
  }

  const list = async (c: import('hono').Context) => {
    const records = await store.listEndpoints()
    return c.json({ data: records.map(serializeEndpoint) })
  }

  const remove = async (c: import('hono').Context) => {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'Missing id' }, 400)
    const ok = await store.deleteEndpoint(id)
    if (!ok) return c.json({ error: 'Webhook endpoint not found' }, 404)
    return c.json({ data: { id, deleted: true } })
  }

  const deliveries = async (c: import('hono').Context) => {
    const id = c.req.param('id')
    if (!id) return c.json({ error: 'Missing id' }, 400)
    const endpoint = await store.getEndpoint(id)
    if (!endpoint) return c.json({ error: 'Webhook endpoint not found' }, 404)
    const rows = await store.listEventsForEndpoint(id, 100)
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        status: r.status,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        nextRetryAt: r.nextRetryAt ? r.nextRetryAt.toISOString() : null,
        lastError: r.lastError,
        createdAt: r.createdAt.toISOString(),
        deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
      })),
    })
  }

  if (guard) {
    app.post('/admin/webhooks', guard, create)
    app.get('/admin/webhooks', guard, list)
    app.delete('/admin/webhooks/:id', guard, remove)
    app.get('/admin/webhooks/:id/deliveries', guard, deliveries)
  } else {
    app.post('/admin/webhooks', create)
    app.get('/admin/webhooks', list)
    app.delete('/admin/webhooks/:id', remove)
    app.get('/admin/webhooks/:id/deliveries', deliveries)
  }
}
