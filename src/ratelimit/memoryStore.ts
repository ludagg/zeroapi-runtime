import type { RateLimitStore } from './store.js'

interface Bucket { count: number; resetAt: number }

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>()

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now()
    const entry = this.buckets.get(key)

    if (!entry || now > entry.resetAt) {
      const resetAt = now + windowMs
      this.buckets.set(key, { count: 1, resetAt })
      return { count: 1, resetAt }
    }

    entry.count++
    return { count: entry.count, resetAt: entry.resetAt }
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key)
  }
}
