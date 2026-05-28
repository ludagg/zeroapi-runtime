import { randomBytes } from 'crypto'

export interface OAuthStateRecord {
  state: string
  provider: string
  redirectTo?: string
  expiresAt: number
}

/**
 * Short-lived store for OAuth CSRF state tokens. The state value is generated
 * before redirecting to the provider and verified on the callback — a missing
 * or expired state rejects the request.
 *
 * Default TTL is 10 minutes, more than enough for a user to complete the
 * consent flow and not so long that an abandoned state stays around forever.
 */
export interface OAuthStateStore {
  create(provider: string, redirectTo?: string): Promise<OAuthStateRecord>
  consume(state: string): Promise<OAuthStateRecord | null>
}

const DEFAULT_TTL_MS = 10 * 60 * 1000

export class MemoryOAuthStateStore implements OAuthStateStore {
  private records = new Map<string, OAuthStateRecord>()
  private readonly ttlMs: number

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  async create(provider: string, redirectTo?: string): Promise<OAuthStateRecord> {
    this.gc()
    const state = randomBytes(32).toString('hex')
    const record: OAuthStateRecord = {
      state,
      provider,
      ...(redirectTo !== undefined ? { redirectTo } : {}),
      expiresAt: Date.now() + this.ttlMs,
    }
    this.records.set(state, record)
    return record
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const rec = this.records.get(state)
    if (!rec) return null
    this.records.delete(state)
    if (rec.expiresAt <= Date.now()) return null
    return rec
  }

  private gc(): void {
    if (this.records.size < 64) return
    const now = Date.now()
    for (const [k, v] of this.records) {
      if (v.expiresAt <= now) this.records.delete(k)
    }
  }
}
