import { randomUUID } from 'crypto'

export interface OAuthAccountRecord {
  id: string
  provider: string
  providerId: string
  userId: string
  createdAt: Date
}

export interface CreateOAuthAccountInput {
  provider: string
  providerId: string
  userId: string
}

/**
 * Persistent store for OAuth account links. One row per (provider, providerId)
 * pair, pointing back to the local `User`. `findByProviderAndProviderId` is the
 * lookup used during the callback; `findByUserId` powers "linked accounts" UIs.
 */
export interface OAuthAccountStore {
  findByProviderAndProviderId(provider: string, providerId: string): Promise<OAuthAccountRecord | null>
  findByUserId(userId: string): Promise<OAuthAccountRecord[]>
  create(input: CreateOAuthAccountInput): Promise<OAuthAccountRecord>
}

function key(provider: string, providerId: string): string {
  return `${provider}::${providerId}`
}

export class MemoryOAuthAccountStore implements OAuthAccountStore {
  private byKey = new Map<string, OAuthAccountRecord>()
  private byUserId = new Map<string, OAuthAccountRecord[]>()

  async findByProviderAndProviderId(provider: string, providerId: string): Promise<OAuthAccountRecord | null> {
    return this.byKey.get(key(provider, providerId)) ?? null
  }

  async findByUserId(userId: string): Promise<OAuthAccountRecord[]> {
    return this.byUserId.get(userId) ?? []
  }

  async create(input: CreateOAuthAccountInput): Promise<OAuthAccountRecord> {
    const record: OAuthAccountRecord = {
      id: randomUUID(),
      provider: input.provider,
      providerId: input.providerId,
      userId: input.userId,
      createdAt: new Date(),
    }
    this.byKey.set(key(input.provider, input.providerId), record)
    const list = this.byUserId.get(input.userId) ?? []
    list.push(record)
    this.byUserId.set(input.userId, list)
    return record
  }
}
