import type { MiddlewareHandler } from 'hono'
import type { RateLimitConfig } from '../types/spec.js'
import type { RateLimitStore } from '../ratelimit/store.js'
import { MemoryRateLimitStore } from '../ratelimit/memoryStore.js'

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
 * Creates a rate-limiting middleware backed by an abstract RateLimitStore.
 * Defaults to MemoryRateLimitStore (in-process, dev-friendly).
 * Pass a RedisRateLimitStore for multi-instance production deployments.
 */
export function createRateLimitMiddleware(
  config: RateLimitConfig,
  storeOverride?: RateLimitStore
): MiddlewareHandler {
  const store: RateLimitStore = storeOverride ?? new MemoryRateLimitStore()

  return async (c, next) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown'

    const { count } = await store.increment(`ip:${ip}`, config.windowMs)
    if (count > config.max) {
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
      if (sub) {
        const { count: userCount } = await store.increment(`user:${sub}`, config.windowMs)
        if (userCount > config.max) {
          return c.json(
            {
              error: config.message ?? 'Rate limit exceeded for this user',
              retryAfter: Math.ceil(config.windowMs / 1000),
            },
            429
          )
        }
      }
    }

    await next()
  }
}
