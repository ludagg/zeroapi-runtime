import type { Hono } from 'hono'
import type { GlobalAuthConfig } from '../types/spec.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  generateAccessToken,
  generateRefreshTokenValue,
  hashRefreshToken,
  verifyAccessToken,
  getAccessTokenTTL,
  getRefreshTokenTTL,
} from './jwt.js'
import type { UserRecord, UserStore } from './user-store.js'
import type { RefreshTokenStore } from './refresh-token-store.js'
import type { TokenRevocationStore } from './token-revocation-store.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function publicUser(u: UserRecord) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    emailVerified: u.emailVerified,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  }
}

function parseRefreshTokenBody(body: Record<string, unknown>): string | null {
  const v = body['refreshToken']
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Mounts the JWT user-system endpoints when `auth.jwt.enabled` is true:
 *   POST /auth/register · POST /auth/login · POST /auth/refresh
 *   POST /auth/logout  · GET  /auth/me
 *
 * All persistence goes through the supplied `UserStore` and `RefreshTokenStore`
 * — the same surface works with the in-memory dev store and the Prisma one.
 */
export function mountJwtAuthRoutes(
  app: Hono,
  config: GlobalAuthConfig,
  secret: string,
  users: UserStore,
  refreshTokens: RefreshTokenStore,
  revocationStore?: TokenRevocationStore,
): void {
  const accessTtlSec = getAccessTokenTTL(config)
  const refreshTtlSec = getRefreshTokenTTL(config)

  async function issueTokens(user: UserRecord): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = await generateAccessToken(user.id, user.email, user.role, secret, accessTtlSec)
    const refreshToken = generateRefreshTokenValue()
    await refreshTokens.create({
      tokenHash: hashRefreshToken(refreshToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + refreshTtlSec * 1000),
    })
    return { accessToken, refreshToken }
  }

  // ── POST /auth/register ───────────────────────────────────────────────────

  app.post('/auth/register', async (c) => {
    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const email = typeof body['email'] === 'string' ? body['email'].toLowerCase().trim() : null
    const password = typeof body['password'] === 'string' ? body['password'] : null

    if (!email || !EMAIL_RE.test(email)) return c.json({ error: 'A valid email is required' }, 400)
    if (!password || password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400)
    }

    if (await users.findByEmail(email)) {
      return c.json({ error: 'Email already registered' }, 409)
    }

    const { hash, salt } = hashPassword(password)
    const user = await users.create({ email, passwordHash: hash, salt, role: 'user' })
    const { accessToken, refreshToken } = await issueTokens(user)

    return c.json({ data: { user: publicUser(user), accessToken, refreshToken } }, 201)
  })

  // ── POST /auth/login ──────────────────────────────────────────────────────

  app.post('/auth/login', async (c) => {
    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const email = typeof body['email'] === 'string' ? body['email'].toLowerCase().trim() : null
    const password = typeof body['password'] === 'string' ? body['password'] : null

    if (!email || !password) return c.json({ error: 'Invalid credentials' }, 401)

    const user = await users.findByEmail(email)
    if (!user) {
      // Burn a hash cycle even on unknown email to keep timing comparable.
      hashPassword(password)
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    if (!verifyPassword(password, user.passwordHash, user.salt)) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    const { accessToken, refreshToken } = await issueTokens(user)
    return c.json({ data: { user: publicUser(user), accessToken, refreshToken } })
  })

  // ── POST /auth/refresh ────────────────────────────────────────────────────

  app.post('/auth/refresh', async (c) => {
    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const incoming = parseRefreshTokenBody(body)
    if (!incoming) return c.json({ error: 'refreshToken is required' }, 400)

    const stored = await refreshTokens.findByHash(hashRefreshToken(incoming))
    if (!stored || stored.revoked || stored.expiresAt.getTime() <= Date.now()) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401)
    }

    const user = await users.findById(stored.userId)
    if (!user) return c.json({ error: 'Invalid or expired refresh token' }, 401)

    // Rotation: revoke the presented token and issue a fresh pair
    await refreshTokens.revoke(stored.id)
    const { accessToken, refreshToken } = await issueTokens(user)

    return c.json({ data: { accessToken, refreshToken } })
  })

  // ── POST /auth/logout ─────────────────────────────────────────────────────

  app.post('/auth/logout', async (c) => {
    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    // P1: revoke the presented ACCESS token (by jti) so a stolen copy can't be
    // reused before its natural expiry — not just the refresh token.
    if (revocationStore) {
      const auth = c.req.header('Authorization')
      if (auth?.startsWith('Bearer ')) {
        const payload = await verifyAccessToken(auth.slice(7).trim(), secret)
        if (payload) await revocationStore.revokeJti(payload.jti, new Date(payload.exp * 1000))
      }
    }

    const incoming = parseRefreshTokenBody(body)
    if (incoming) {
      const stored = await refreshTokens.findByHash(hashRefreshToken(incoming))
      if (stored && !stored.revoked) await refreshTokens.revoke(stored.id)
    }
    return c.json({ data: { message: 'Logged out' } })
  })

  // ── GET /auth/me ──────────────────────────────────────────────────────────

  app.get('/auth/me', async (c) => {
    const header = c.req.header('Authorization')
    if (!header || !header.startsWith('Bearer ')) {
      return c.json({ error: 'Authentication required' }, 401)
    }
    const token = header.slice(7).trim()
    const payload = await verifyAccessToken(token, secret)
    if (!payload) return c.json({ error: 'Invalid or expired token' }, 401)

    const user = await users.findById(payload.sub)
    if (!user) return c.json({ error: 'Invalid or expired token' }, 401)

    return c.json({ data: { user: publicUser(user) } })
  })
}
