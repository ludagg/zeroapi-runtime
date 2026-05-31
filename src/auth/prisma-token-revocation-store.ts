import type { RevokedTokenInfo, TokenRevocationStore } from './token-revocation-store.js'

/**
 * The slice of the `RevokedToken` Prisma model delegate we rely on. Structural,
 * so we never pull `@prisma/client` in as a hard dependency.
 */
export interface PrismaRevokedTokenDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>
  findFirst(args: { where: Record<string, unknown> }): Promise<unknown | null>
}

export interface PrismaRevocationLikeClient {
  revokedToken: PrismaRevokedTokenDelegate
}

/**
 * Prisma-backed {@link TokenRevocationStore}. Durable across restarts and shared
 * across instances. One row per revocation; `isRevoked` is a single `findFirst`
 * that matches EITHER the token's `jti` OR a user cutoff covering its `iat`,
 * restricted to entries that haven't themselves expired.
 *
 * Backed by the generated model:
 *   model RevokedToken { id, jti? @unique, userId?, notBefore?, expiresAt, createdAt }
 */
export class PrismaTokenRevocationStore implements TokenRevocationStore {
  constructor(private readonly client: PrismaRevocationLikeClient) {}

  async isRevoked(token: RevokedTokenInfo): Promise<boolean> {
    const now = new Date()
    const row = await this.client.revokedToken.findFirst({
      where: {
        expiresAt: { gt: now },
        OR: [
          { jti: token.jti },
          { userId: token.sub, notBefore: { gt: new Date(token.iat * 1000) } },
        ],
      },
    })
    return row !== null && row !== undefined
  }

  async revokeJti(jti: string, expiresAt: Date): Promise<void> {
    try {
      await this.client.revokedToken.create({ data: { jti, expiresAt } })
    } catch {
      // Unique violation (P2002) → the token is already revoked. Idempotent.
    }
  }

  async revokeUser(userId: string, cutoff: Date, expiresAt: Date): Promise<void> {
    await this.client.revokedToken.create({
      data: { userId, notBefore: cutoff, expiresAt },
    })
  }
}
