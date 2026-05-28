import type { Hono, MiddlewareHandler } from 'hono'
import type { GlobalAuthConfig } from '../types/spec.js'
import type { ApiKeyStore } from './apikey-store.js'
import { generateApiKey } from './apikey.js'

function resolvePrefix(config: GlobalAuthConfig): string {
  return config.apikey?.prefix ?? 'zak_live_'
}

/**
 * Mounts the admin API-key management endpoints. All routes require a valid,
 * non-revoked API key — passed through the supplied `guard` middleware.
 */
export function mountApiKeyRoutes(
  app: Hono,
  config: GlobalAuthConfig,
  store: ApiKeyStore,
  guard: MiddlewareHandler,
): void {
  const prefix = resolvePrefix(config)

  app.post('/admin/api-keys', guard, async (c) => {
    let body: Record<string, unknown> = {}
    try { body = await c.req.json() } catch { /* body is optional */ }

    const name = typeof body['name'] === 'string' && body['name'].length > 0
      ? body['name']
      : undefined

    const { key, keyHash, keyPrefix } = generateApiKey(prefix)
    const record = await store.create({ keyHash, keyPrefix, name })

    return c.json({
      data: {
        id: record.id,
        key,
        keyPrefix: record.keyPrefix,
        name: record.name ?? null,
        createdAt: record.createdAt.toISOString(),
      },
    }, 201)
  })

  app.get('/admin/api-keys', guard, async (c) => {
    const records = await store.list()
    return c.json({
      data: records.map((r) => ({
        id: r.id,
        keyPrefix: r.keyPrefix,
        name: r.name ?? null,
        revoked: r.revoked,
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  })

  app.delete('/admin/api-keys/:id', guard, async (c) => {
    const id = c.req.param('id')
    const ok = await store.revoke(id)
    if (!ok) return c.json({ error: 'API key not found' }, 404)
    return c.json({ data: { id, revoked: true } })
  })
}
