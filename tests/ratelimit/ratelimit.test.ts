import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { MemoryRateLimitStore } from '../../src/ratelimit/memoryStore.js'
import { RedisRateLimitStore } from '../../src/ratelimit/redisStore.js'
import { createRateLimitMiddleware } from '../../src/security/ratelimit.js'
import type { RateLimitStore } from '../../src/ratelimit/store.js'
import type { RedisLike } from '../../src/ratelimit/redisStore.js'

// ── MemoryRateLimitStore ──────────────────────────────────────────────────────

describe('MemoryRateLimitStore', () => {
  it('first increment returns count 1', async () => {
    const store = new MemoryRateLimitStore()
    const { count } = await store.increment('key', 60_000)
    expect(count).toBe(1)
  })

  it('increments count for repeated calls on same key', async () => {
    const store = new MemoryRateLimitStore()
    await store.increment('key', 60_000)
    await store.increment('key', 60_000)
    const { count } = await store.increment('key', 60_000)
    expect(count).toBe(3)
  })

  it('different keys have independent counters', async () => {
    const store = new MemoryRateLimitStore()
    await store.increment('a', 60_000)
    await store.increment('a', 60_000)
    const { count: b } = await store.increment('b', 60_000)
    expect(b).toBe(1)
  })

  it('resetAt is approximately now + windowMs', async () => {
    const store = new MemoryRateLimitStore()
    const before = Date.now()
    const { resetAt } = await store.increment('key', 10_000)
    const after = Date.now()
    expect(resetAt).toBeGreaterThanOrEqual(before + 10_000)
    expect(resetAt).toBeLessThanOrEqual(after + 10_000 + 5)
  })

  it('resets window after expiry — count returns to 1', async () => {
    const store = new MemoryRateLimitStore()
    await store.increment('key', 1)  // 1ms window
    await new Promise((r) => setTimeout(r, 20))
    const { count } = await store.increment('key', 60_000)
    expect(count).toBe(1)
  })

  it('reset() removes the bucket — next increment starts fresh', async () => {
    const store = new MemoryRateLimitStore()
    await store.increment('key', 60_000)
    await store.increment('key', 60_000)
    await store.reset('key')
    const { count } = await store.increment('key', 60_000)
    expect(count).toBe(1)
  })
})

// ── RedisRateLimitStore ───────────────────────────────────────────────────────

describe('RedisRateLimitStore', () => {
  function makeRedis(): { client: RedisLike; calls: Record<string, unknown[][]> } {
    let counter = 0
    const calls: Record<string, unknown[][]> = { incr: [], pexpire: [], pttl: [], del: [] }
    const client: RedisLike = {
      incr: async (key) => { calls['incr']!.push([key]); return ++counter },
      pexpire: async (key, ms) => { calls['pexpire']!.push([key, ms]); return 1 },
      pttl: async (_key) => { calls['pttl']!.push([_key]); return 59_000 },
      del: async (key) => { calls['del']!.push([key]); counter = 0; return 1 },
    }
    return { client, calls }
  }

  it('calls redis.incr with the key', async () => {
    const { client, calls } = makeRedis()
    const store = new RedisRateLimitStore(client)
    await store.increment('ip:1.2.3.4', 60_000)
    expect(calls['incr']).toHaveLength(1)
    expect(calls['incr']![0]).toEqual(['ip:1.2.3.4'])
  })

  it('calls pexpire on first increment (count === 1)', async () => {
    const { client, calls } = makeRedis()
    const store = new RedisRateLimitStore(client)
    await store.increment('ip:1.2.3.4', 60_000)
    expect(calls['pexpire']).toHaveLength(1)
    expect(calls['pexpire']![0]).toEqual(['ip:1.2.3.4', 60_000])
  })

  it('does not call pexpire on subsequent increments', async () => {
    let callCount = 0
    const client: RedisLike = {
      incr: async () => ++callCount,
      pexpire: async () => 1,
      pttl: async () => 59_000,
    }
    // First call: incr returns 1 → pexpire called
    await new RedisRateLimitStore(client).increment('k', 60_000)
    // Use a fresh client for second call where incr returns 2
    let secondCount = 1
    const calls2: string[] = []
    const client2: RedisLike = {
      incr: async () => ++secondCount,
      pexpire: async (k) => { calls2.push(k); return 1 },
      pttl: async () => 59_000,
    }
    const store2 = new RedisRateLimitStore(client2)
    await store2.increment('k', 60_000)
    expect(calls2).toHaveLength(0)
  })

  it('reset() calls redis.del with the key', async () => {
    const { client, calls } = makeRedis()
    const store = new RedisRateLimitStore(client)
    await store.reset('ip:1.2.3.4')
    expect(calls['del']).toHaveLength(1)
    expect(calls['del']![0]).toEqual(['ip:1.2.3.4'])
  })

  it('reset() is a no-op when redis.del is not available', async () => {
    const client: RedisLike = {
      incr: async () => 1,
      pexpire: async () => 1,
      pttl: async () => 59_000,
      // del intentionally omitted
    }
    const store = new RedisRateLimitStore(client)
    await expect(store.reset('any')).resolves.toBeUndefined()
  })
})

// ── createRateLimitMiddleware with custom store ────────────────────────────────

describe('createRateLimitMiddleware with custom RateLimitStore', () => {
  it('uses the provided store instead of the default memory store', async () => {
    const incrementCalls: string[] = []
    const customStore: RateLimitStore = {
      increment: async (key, _w) => { incrementCalls.push(key); return { count: 1, resetAt: Date.now() + 60_000 } },
      reset: async () => {},
    }

    const app = new Hono()
    app.use('*', createRateLimitMiddleware({ windowMs: 60_000, max: 10 }, customStore))
    app.get('/', (c) => c.text('ok'))

    await app.request('/')
    expect(incrementCalls.some((k) => k.startsWith('ip:'))).toBe(true)
  })

  it('blocks when custom store returns count above max', async () => {
    const alwaysOverLimit: RateLimitStore = {
      increment: async () => ({ count: 999, resetAt: Date.now() + 60_000 }),
      reset: async () => {},
    }

    const app = new Hono()
    app.use('*', createRateLimitMiddleware({ windowMs: 60_000, max: 10 }, alwaysOverLimit))
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/')
    expect(res.status).toBe(429)
  })
})
