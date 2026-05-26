import type { RateLimitStore } from './store.js'

/** Minimal Redis client interface — compatible with ioredis and node-redis. */
export interface RedisLike {
  incr(key: string): Promise<number>
  pexpire(key: string, ms: number): Promise<number>
  pttl(key: string): Promise<number>
  del?(key: string): Promise<number>
}

/**
 * Redis-backed rate limit store for multi-instance deployments.
 * Pass an ioredis or node-redis client instance.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const count = await this.redis.incr(key)
    if (count === 1) await this.redis.pexpire(key, windowMs)
    const ttl = await this.redis.pttl(key)
    const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs)
    return { count, resetAt }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del?.(key)
  }
}
