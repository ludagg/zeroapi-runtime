import type {
  CreateRefreshTokenInput,
  RefreshTokenRecord,
  RefreshTokenStore,
} from './refresh-token-store.js'

export interface PrismaRefreshTokenRow {
  id: string
  tokenHash: string
  userId: string
  expiresAt: Date
  revoked: boolean
  createdAt: Date
}

export interface PrismaRefreshTokenDelegate {
  findUnique(args: { where: { tokenHash: string } }): Promise<PrismaRefreshTokenRow | null>
  create(args: {
    data: { tokenHash: string; userId: string; expiresAt: Date }
  }): Promise<PrismaRefreshTokenRow>
  update(args: {
    where: { id: string }
    data: { revoked: boolean }
  }): Promise<PrismaRefreshTokenRow>
}

export interface PrismaRefreshTokenLikeClient {
  refreshToken: PrismaRefreshTokenDelegate
}

function toRecord(r: PrismaRefreshTokenRow): RefreshTokenRecord {
  return {
    id: r.id,
    tokenHash: r.tokenHash,
    userId: r.userId,
    expiresAt: r.expiresAt,
    revoked: r.revoked,
    createdAt: r.createdAt,
  }
}

/**
 * Prisma-backed `RefreshTokenStore`. Stores only the SHA-256 hash of each
 * issued refresh token plus its expiry/revocation flags.
 */
export class PrismaRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly prisma: PrismaRefreshTokenLikeClient) {}

  async findByHash(hash: string): Promise<RefreshTokenRecord | null> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } })
    return row ? toRecord(row) : null
  }

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
    const row = await this.prisma.refreshToken.create({
      data: {
        tokenHash: input.tokenHash,
        userId: input.userId,
        expiresAt: input.expiresAt,
      },
    })
    return toRecord(row)
  }

  async revoke(id: string): Promise<boolean> {
    try {
      await this.prisma.refreshToken.update({ where: { id }, data: { revoked: true } })
      return true
    } catch {
      return false
    }
  }
}
