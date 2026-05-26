import type { MiddlewareHandler } from 'hono'
import type { GlobalAuthConfig } from '../types/spec.js'
import { verify } from 'hono/jwt'

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 401
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Creates a Hono middleware that enforces authentication based on the global auth config.
 * Supports JWT/Bearer token verification (with optional secret) and API key presence checks.
 */
export function createAuthMiddleware(config: GlobalAuthConfig): MiddlewareHandler {
  return async (c, next) => {
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
        // Without a secret, only validate token structure (3-part JWT)
        const parts = token.split('.')
        if (parts.length !== 3) {
          return c.json({ error: 'Invalid JWT structure' }, 401)
        }
      }
    } else if (config.strategy === 'apikey') {
      const key = headerValue.startsWith('ApiKey ')
        ? headerValue.slice(7)
        : headerValue

      if (!key || key.length < 16) {
        return c.json({ error: 'Invalid API key — must be at least 16 characters' }, 401)
      }
    }

    await next()
  }
}
