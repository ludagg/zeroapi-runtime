import type { ApiKeyRecord, ApiKeyStore, CreateApiKeyInput } from './apikey-store.js'

/**
 * Shape we need from a Prisma-generated `apiKey` delegate. Structural so we
 * don't pull `@prisma/client` into this package as a hard dependency — any
 * client whose generated `apiKey` model matches the schema in
 * `src/generators/schema.ts` will satisfy this type.
 */
export interface PrismaApiKeyRow {
  id: string
  keyHash: string
  keyPrefix: string
  name: string | null
  revoked: boolean
  lastUsedAt: Date | null
  createdAt: Date
}

export interface PrismaApiKeyDelegate {
  findUnique(args: { where: { keyHash: string } }): Promise<PrismaApiKeyRow | null>
  findMany(args?: { orderBy?: { createdAt: 'asc' | 'desc' } }): Promise<PrismaApiKeyRow[]>
  create(args: { data: { keyHash: string; keyPrefix: string; name?: string } }): Promise<PrismaApiKeyRow>
  update(args: { where: { id: string }; data: { revoked?: boolean; lastUsedAt?: Date } }): Promise<PrismaApiKeyRow>
  count(): Promise<number>
}

export interface PrismaLikeClient {
  apiKey: PrismaApiKeyDelegate
}

function toRecord(r: PrismaApiKeyRow): ApiKeyRecord {
  return {
    id: r.id,
    keyHash: r.keyHash,
    keyPrefix: r.keyPrefix,
    name: r.name ?? undefined,
    revoked: r.revoked,
    lastUsedAt: r.lastUsedAt ?? undefined,
    createdAt: r.createdAt,
  }
}

/**
 * Prisma-backed implementation of `ApiKeyStore`. Persists keys to the database
 * so they survive restarts and are shared across instances — the default in
 * production when a Prisma client is available.
 */
export class PrismaApiKeyStore implements ApiKeyStore {
  constructor(private readonly prisma: PrismaLikeClient) {}

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.apiKey.findUnique({ where: { keyHash: hash } })
    return row ? toRecord(row) : null
  }

  async create(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
    const row = await this.prisma.apiKey.create({
      data: {
        keyHash: input.keyHash,
        keyPrefix: input.keyPrefix,
        ...(input.name !== undefined ? { name: input.name } : {}),
      },
    })
    return toRecord(row)
  }

  async list(): Promise<ApiKeyRecord[]> {
    const rows = await this.prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } })
    return rows.map(toRecord)
  }

  async revoke(id: string): Promise<boolean> {
    try {
      await this.prisma.apiKey.update({ where: { id }, data: { revoked: true } })
      return true
    } catch {
      return false
    }
  }

  async updateLastUsed(id: string, when: Date): Promise<void> {
    try {
      await this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: when } })
    } catch {
      /* best-effort */
    }
  }

  async count(): Promise<number> {
    return this.prisma.apiKey.count()
  }
}
