import type { MiddlewareHandler } from 'hono'
import type { RateLimitConfig } from '../types/spec.js'

interface Bucket {
  count: number
  resetAt: number
}

function check(key: string, store: Map<string, Bucket>, config: RateLimitConfig): boolean {
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + config.windowMs })
    return true
  }
  if (entry.count >= config.max) {
    return false
  }
  entry.count++
  return true
}

function extractJwtSub(authHeader: string): string | null {
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const raw = parts[1]
    if (!raw) return null
    const payload = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf-8')
    ) as { sub?: string }
    return payload.sub ?? null
  } catch {
    return null
  }
}

/**
 * Creates an in-memory rate-limiting middleware.
 * Limits by client IP, and optionally also by JWT `sub` when byUser is true.
 * Returns 429 with a `retryAfter` hint when limits are exceeded.
 */
export function createRateLimitMiddleware(config: RateLimitConfig): MiddlewareHandler {
  const store = new Map<string, Bucket>()

  return async (c, next) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown'

    if (!check(`ip:${ip}`, store, config)) {
      return c.json(
        {
          error: config.message ?? 'Too many requests — please slow down',
          retryAfter: Math.ceil(config.windowMs / 1000),
        },
        429
      )
    }

    if (config.byUser) {
      const auth = c.req.header('Authorization') ?? ''
      const sub = extractJwtSub(auth)
      if (sub && !check(`user:${sub}`, store, config)) {
        return c.json(
          {
            error: config.message ?? 'Rate limit exceeded for this user',
            retryAfter: Math.ceil(config.windowMs / 1000),
          },
          429
        )
      }
    }

    await next()
  }
}
