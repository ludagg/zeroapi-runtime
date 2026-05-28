import type { MiddlewareHandler } from 'hono'
import type { GlobalAuthConfig } from '../types/spec.js'
import { verify } from 'hono/jwt'
import { timingSafeEqual } from 'crypto'
import type { ApiKeyStore } from './apikey-store.js'
import { hashApiKey } from './apikey.js'

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 401
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

function isApiKeyStrategy(config: GlobalAuthConfig): boolean {
  return config.strategy === 'apikey' || config.apikey?.enabled === true
}

function resolveApiKeyHeader(config: GlobalAuthConfig): string {
  if (config.apikey?.header) return config.apikey.header
  // For the apikey strategy we default to x-api-key (not Authorization),
  // so JWT-style "Authorization: Bearer ..." headers don't leak through.
  if (config.strategy === 'apikey' && config.header) return config.header
  return 'x-api-key'
}

/**
 * Creates a Hono middleware that enforces authentication based on the global auth config.
 *
 * - JWT/Bearer: verifies the token signature when a secret is configured, otherwise
 *   only validates the 3-part token structure.
 * - API key: hashes the incoming key, looks it up in the supplied `ApiKeyStore`,
 *   and timing-safe compares the stored hash. Without a store the middleware falls
 *   back to a no-op length check — present so the legacy code path keeps working
 *   when callers wire the middleware manually; the runtime always provides a store.
 */
export function createAuthMiddleware(
  config: GlobalAuthConfig,
  apiKeyStore?: ApiKeyStore,
): MiddlewareHandler {
  const apiKeyHeader = resolveApiKeyHeader(config)

  return async (c, next) => {
    if (isApiKeyStrategy(config)) {
      const raw = c.req.header(apiKeyHeader)
      if (!raw) return c.json({ error: 'Invalid API key' }, 401)

      const key = raw.startsWith('ApiKey ') ? raw.slice(7).trim() : raw.trim()
      if (!key) return c.json({ error: 'Invalid API key' }, 401)

      if (!apiKeyStore) {
        if (key.length < 16) return c.json({ error: 'Invalid API key' }, 401)
        await next()
        return
      }

      const incomingHash = hashApiKey(key)
      const record = await apiKeyStore.findByHash(incomingHash)
      if (!record || record.revoked) {
        return c.json({ error: 'Invalid API key' }, 401)
      }

      const a = Buffer.from(record.keyHash, 'hex')
      const b = Buffer.from(incomingHash, 'hex')
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return c.json({ error: 'Invalid API key' }, 401)
      }

      apiKeyStore.updateLastUsed(record.id, new Date()).catch(() => { /* best-effort */ })
      c.set('apiKey', { id: record.id, keyPrefix: record.keyPrefix, name: record.name })
      await next()
      return
    }

    const headerName = config.header ?? 'Authorization'
    const headerValue = c.req.header(headerName)

    if (!headerValue) {
      return c.json({ error: 'Authentication required', hint: `Provide a ${headerName} header` }, 401)
    }

    if (config.strategy === 'jwt' || config.strategy === 'bearer') {
      const token = headerValue.startsWith('Bearer ')
        ? headerValue.slice(7)
        : headerValue

      if (!token) {
        return c.json({ error: 'Token missing from Authorization header' }, 401)
      }

      if (config.secret) {
        try {
          await verify(token, config.secret, 'HS256')
        } catch {
          return c.json({ error: 'Invalid or expired token' }, 401)
        }
      } else {
        const parts = token.split('.')
        if (parts.length !== 3) {
          return c.json({ error: 'Invalid JWT structure' }, 401)
        }
      }
    }

    await next()
  }
}
