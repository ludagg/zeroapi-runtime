import { randomUUID } from 'crypto'

export interface ApiKeyRecord {
  id: string
  keyHash: string
  keyPrefix: string
  name?: string
  /** RBAC role carried by requests authenticated with this key. Defaults to 'admin'. */
  role: string
  revoked: boolean
  lastUsedAt?: Date
  createdAt: Date
}

export interface CreateApiKeyInput {
  keyHash: string
  keyPrefix: string
  name?: string
  role?: string
}

/**
 * Storage abstraction for API keys. Implemented in-memory by default; consumers
 * can plug in a Prisma-backed implementation when running with a real database.
 */
export interface ApiKeyStore {
  findByHash(hash: string): Promise<ApiKeyRecord | null>
  create(input: CreateApiKeyInput): Promise<ApiKeyRecord>
  list(): Promise<ApiKeyRecord[]>
  revoke(id: string): Promise<boolean>
  updateLastUsed(id: string, when: Date): Promise<void>
  count(): Promise<number>
}

export class MemoryApiKeyStore implements ApiKeyStore {
  private records = new Map<string, ApiKeyRecord>()
  private hashIndex = new Map<string, string>()

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const id = this.hashIndex.get(hash)
    if (!id) return null
    return this.records.get(id) ?? null
  }

  async create(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
    return this.createSync(input)
  }

  async list(): Promise<ApiKeyRecord[]> {
    return [...this.records.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )
  }

  async revoke(id: string): Promise<boolean> {
    const r = this.records.get(id)
    if (!r) return false
    r.revoked = true
    return true
  }

  async updateLastUsed(id: string, when: Date): Promise<void> {
    const r = this.records.get(id)
    if (r) r.lastUsedAt = when
  }

  async count(): Promise<number> {
    return this.records.size
  }

  // ── Synchronous internals — used by the runtime to bootstrap atomically ───

  /** @internal */
  countSync(): number {
    return this.records.size
  }

  /** @internal */
  createSync(input: CreateApiKeyInput): ApiKeyRecord {
    const id = randomUUID()
    const record: ApiKeyRecord = {
      id,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      name: input.name,
      role: input.role ?? 'admin',
      revoked: false,
      createdAt: new Date(),
    }
    this.records.set(id, record)
    this.hashIndex.set(input.keyHash, id)
    return record
  }
}
