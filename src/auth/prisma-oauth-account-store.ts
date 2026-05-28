import type {
  CreateOAuthAccountInput,
  OAuthAccountRecord,
  OAuthAccountStore,
} from './oauth-account-store.js'

export interface PrismaOAuthAccountRow {
  id: string
  provider: string
  providerId: string
  userId: string
  createdAt: Date
}

export interface PrismaOAuthAccountDelegate {
  findUnique(args: {
    where: { provider_providerId: { provider: string; providerId: string } }
  }): Promise<PrismaOAuthAccountRow | null>
  findMany(args: { where: { userId: string } }): Promise<PrismaOAuthAccountRow[]>
  create(args: {
    data: { provider: string; providerId: string; userId: string }
  }): Promise<PrismaOAuthAccountRow>
}

export interface PrismaOAuthAccountLikeClient {
  oAuthAccount: PrismaOAuthAccountDelegate
}

function toRecord(r: PrismaOAuthAccountRow): OAuthAccountRecord {
  return {
    id: r.id,
    provider: r.provider,
    providerId: r.providerId,
    userId: r.userId,
    createdAt: r.createdAt,
  }
}

/**
 * Prisma-backed `OAuthAccountStore`. Uses the `@@unique([provider, providerId])`
 * composite index to look up an existing link.
 */
export class PrismaOAuthAccountStore implements OAuthAccountStore {
  constructor(private readonly prisma: PrismaOAuthAccountLikeClient) {}

  async findByProviderAndProviderId(provider: string, providerId: string): Promise<OAuthAccountRecord | null> {
    const row = await this.prisma.oAuthAccount.findUnique({
      where: { provider_providerId: { provider, providerId } },
    })
    return row ? toRecord(row) : null
  }

  async findByUserId(userId: string): Promise<OAuthAccountRecord[]> {
    const rows = await this.prisma.oAuthAccount.findMany({ where: { userId } })
    return rows.map(toRecord)
  }

  async create(input: CreateOAuthAccountInput): Promise<OAuthAccountRecord> {
    const row = await this.prisma.oAuthAccount.create({
      data: {
        provider: input.provider,
        providerId: input.providerId,
        userId: input.userId,
      },
    })
    return toRecord(row)
  }
}
