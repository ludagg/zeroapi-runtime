export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>
  reset(key: string): Promise<void>
}
