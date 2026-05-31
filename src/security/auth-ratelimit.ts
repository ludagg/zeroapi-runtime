import type { MiddlewareHandler } from 'hono'
import type { RateLimitStore } from '../ratelimit/store.js'
import { MemoryRateLimitStore } from '../ratelimit/memoryStore.js'

/** Tunable for the per-IP auth rate limiter (P1). */
export interface AuthRateLimitConfig {
  /** Sliding window length in ms. Default: 15 minutes. */
  windowMs: number
  /** Max auth attempts per IP per window. Default: 20. */
  max: number
}

export const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 20,
}

/**
 * Per-IP rate limiter dedicated to the auth endpoints (`/auth/login`,
 * `/auth/register`) — defence-in-depth against credential brute force, on top
 * of the per-account lockout. Uses the same {@link RateLimitStore} abstraction
 * (in-memory by default, Redis for multi-instance) under a separate `authrl:`
 * key namespace so it never collides with the global rate limiter.
 */
export function createAuthRateLimitMiddleware(
  config: AuthRateLimitConfig = DEFAULT_AUTH_RATE_LIMIT,
  storeOverride?: RateLimitStore,
): MiddlewareHandler {
  const store: RateLimitStore = storeOverride ?? new MemoryRateLimitStore()

  return async (c, next) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown'

    const { count } = await store.increment(`authrl:ip:${ip}`, config.windowMs)
    if (count > config.max) {
      return c.json(
        {
          error: 'Too many authentication attempts — please try again later',
          retryAfter: Math.ceil(config.windowMs / 1000),
        },
        429,
      )
    }

    await next()
  }
}
