import type { Context, MiddlewareHandler } from 'hono'
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

function isJwtUserSystemEnabled(config: GlobalAuthConfig): boolean {
  return config.jwt?.enabled === true
}

function resolveApiKeyHeader(config: GlobalAuthConfig): string {
  if (config.apikey?.header) return config.apikey.header
  // For the apikey strategy we default to x-api-key (not Authorization),
  // so JWT-style "Authorization: Bearer ..." headers don't leak through.
  if (config.strategy === 'apikey' && config.header) return config.header
  return 'x-api-key'
}

async function tryApiKey(
  c: Context,
  apiKeyStore: ApiKeyStore,
  headerName: string,
): Promise<boolean> {
  const raw = c.req.header(headerName)
  if (!raw) return false
  const key = raw.startsWith('ApiKey ') ? raw.slice(7).trim() : raw.trim()
  if (!key) return false

  const incomingHash = hashApiKey(key)
  const record = await apiKeyStore.findByHash(incomingHash)
  if (!record || record.revoked) return false

  const a = Buffer.from(record.keyHash, 'hex')
  const b = Buffer.from(incomingHash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  apiKeyStore.updateLastUsed(record.id, new Date()).catch(() => { /* best-effort */ })
  c.set('apiKey', {
    id: record.id,
    keyPrefix: record.keyPrefix,
    name: record.name,
    role: record.role,
  })
  return true
}

async function tryJwt(c: Context, secret: string | undefined): Promise<boolean> {
  const header = c.req.header('Authorization')
  if (!header) return false
  const token = header.startsWith('Bearer ') ? header.slice(7) : header
  if (!token) return false

  if (secret) {
    try {
      const payload = await verify(token, secret, 'HS256') as Record<string, unknown>
      if (typeof payload['sub'] === 'string') {
        c.set('user', {
          sub: payload['sub'],
          email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
          role: typeof payload['role'] === 'string' ? payload['role'] : undefined,
        })
      }
      return true
    } catch {
      return false
    }
  }
  // No secret configured — fall back to structural check only.
  return token.split('.').length === 3
}

/**
 * Creates a Hono middleware that enforces authentication based on the global auth config.
 *
 * - JWT/Bearer: verifies the token signature when a secret is configured, otherwise
 *   only validates the 3-part token structure.
 * - API key: hashes the incoming key, looks it up in the supplied `ApiKeyStore`,
 *   and timing-safe compares the stored hash. A store is **required** when apikey
 *   auth is active — the constructor throws otherwise, so there is no code path
 *   that accepts unverified keys.
 */
export function createAuthMiddleware(
  config: GlobalAuthConfig,
  apiKeyStore?: ApiKeyStore,
  jwtSecret?: string,
): MiddlewareHandler {
  const apiKeyOn = isApiKeyStrategy(config)
  const jwtOn = isJwtUserSystemEnabled(config)

  if (apiKeyOn && !apiKeyStore) {
    throw new AuthError(
      'apikey auth is enabled but no ApiKeyStore was provided. ' +
      'Pass `apiKeyStore` to createRuntime, or wire one explicitly when calling createAuthMiddleware. ' +
      'Refusing to construct a middleware that cannot verify keys.',
      500,
    )
  }
  const apiKeyHeader = resolveApiKeyHeader(config)
  // The user-system JWT secret takes precedence; fall back to the legacy
  // `auth.secret` for the bearer-only configurations from earlier phases.
  const effectiveJwtSecret = jwtSecret ?? config.secret

  return async (c, next) => {
    // When both strategies are active, accept either — JWT-via-Bearer first
    // (so an Authorization header isn't mistaken for an API key), then apikey.
    if (jwtOn && apiKeyOn) {
      if (await tryJwt(c, effectiveJwtSecret)) { await next(); return }
      if (await tryApiKey(c, apiKeyStore!, apiKeyHeader)) { await next(); return }
      return c.json({ error: 'Authentication required' }, 401)
    }

    if (apiKeyOn) {
      if (await tryApiKey(c, apiKeyStore!, apiKeyHeader)) { await next(); return }
      return c.json({ error: 'Invalid API key' }, 401)
    }

    if (jwtOn) {
      if (await tryJwt(c, effectiveJwtSecret)) { await next(); return }
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    // Legacy single-strategy path (kept for backwards compatibility).
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
