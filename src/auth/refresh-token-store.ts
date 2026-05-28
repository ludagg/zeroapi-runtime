import { randomUUID } from 'crypto'

export interface RefreshTokenRecord {
  id: string
  tokenHash: string
  userId: string
  expiresAt: Date
  revoked: boolean
  createdAt: Date
}

export interface CreateRefreshTokenInput {
  tokenHash: string
  userId: string
  expiresAt: Date
}

/**
 * Persistent store for refresh tokens. The plaintext value is never persisted —
 * only its SHA-256 hash, so a DB leak doesn't grant immediate access.
 */
export interface RefreshTokenStore {
  findByHash(hash: string): Promise<RefreshTokenRecord | null>
  create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord>
  revoke(id: string): Promise<boolean>
}

export class MemoryRefreshTokenStore implements RefreshTokenStore {
  private byId = new Map<string, RefreshTokenRecord>()
  private byHash = new Map<string, string>()

  async findByHash(hash: string): Promise<RefreshTokenRecord | null> {
    const id = this.byHash.get(hash)
    if (!id) return null
    return this.byId.get(id) ?? null
  }

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = {
      id: randomUUID(),
      tokenHash: input.tokenHash,
      userId: input.userId,
      expiresAt: input.expiresAt,
      revoked: false,
      createdAt: new Date(),
    }
    this.byId.set(record.id, record)
    this.byHash.set(record.tokenHash, record.id)
    return record
  }

  async revoke(id: string): Promise<boolean> {
    const r = this.byId.get(id)
    if (!r) return false
    r.revoked = true
    return true
  }
}
