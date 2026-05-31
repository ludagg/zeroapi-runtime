/**
 * Token-revocation store (P1 security). Backs access-token revocation so a
 * stolen token can be killed before its natural expiry, and so deleting a user
 * cuts all of their live sessions.
 *
 * Two revocation kinds, ONE read per authenticated request:
 *   - jti revocation  → a single access token (logout of one session)
 *   - user cutoff     → every token for a user issued at/before a timestamp
 *                       (logout-all / user deletion)
 *
 * The plaintext token is never stored — only its `jti`. Entries carry an
 * `expiresAt` so they become inert (and are prunable) once the longest possible
 * access-token lifetime has passed.
 */
export interface RevokedTokenInfo {
  /** RFC 7519 token id from the verified access-token payload. */
  jti: string
  /** Subject (user id) from the verified payload. */
  sub: string
  /** Issued-at (seconds) from the verified payload. */
  iat: number
}

export interface TokenRevocationStore {
  /**
   * True when the token is revoked — either its `jti` was revoked, or all of
   * the user's tokens issued at/before a cutoff were revoked. One lookup.
   */
  isRevoked(token: RevokedTokenInfo): Promise<boolean>
  /** Revoke a single access token by `jti` until it would naturally expire. */
  revokeJti(jti: string, expiresAt: Date): Promise<void>
  /**
   * Revoke every token for `userId` issued at/before `cutoff` (logout-all /
   * user deletion). `expiresAt` lets the marker be pruned after the longest
   * possible access-token lifetime.
   */
  revokeUser(userId: string, cutoff: Date, expiresAt: Date): Promise<void>
}

interface UserCutoff {
  cutoffMs: number
  expMs: number
}

/**
 * In-memory revocation store (dev/test default). Volatile — entries are lost on
 * restart, which is acceptable for the memory runtime (its tokens use an
 * ephemeral signing secret that also resets on restart).
 */
export class MemoryTokenRevocationStore implements TokenRevocationStore {
  private jti = new Map<string, number>()      // jti  → expiresAt (ms)
  private users = new Map<string, UserCutoff>() // userId → { cutoff, expiresAt } (ms)

  async isRevoked(token: RevokedTokenInfo): Promise<boolean> {
    const now = Date.now()

    const jtiExp = this.jti.get(token.jti)
    if (jtiExp !== undefined) {
      if (jtiExp > now) return true
      this.jti.delete(token.jti) // expired — prune lazily
    }

    const cutoff = this.users.get(token.sub)
    if (cutoff !== undefined) {
      if (cutoff.expMs > now) {
        // iat is in seconds; a token issued before the cutoff is revoked.
        if (token.iat * 1000 < cutoff.cutoffMs) return true
      } else {
        this.users.delete(token.sub)
      }
    }

    return false
  }

  async revokeJti(jti: string, expiresAt: Date): Promise<void> {
    this.jti.set(jti, expiresAt.getTime())
  }

  async revokeUser(userId: string, cutoff: Date, expiresAt: Date): Promise<void> {
    const existing = this.users.get(userId)
    const cutoffMs = cutoff.getTime()
    const expMs = expiresAt.getTime()
    // Keep the LATEST cutoff (a newer revoke-all must not be weakened).
    if (existing && existing.cutoffMs >= cutoffMs) {
      if (expMs > existing.expMs) existing.expMs = expMs
      return
    }
    this.users.set(userId, { cutoffMs, expMs })
  }
}
