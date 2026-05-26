import { randomBytes, pbkdf2Sync } from 'crypto'
import type { Hono } from 'hono'
import { sign } from 'hono/jwt'
import type { ZeroAPISpec } from '../../types/spec.js'
import type { AuthFlowsConfig, LockoutConfig } from '../../types/spec.js'

// ── Internal user store ───────────────────────────────────────────────────────

interface AuthUser {
  id: string
  email: string
  passwordHash: string
  salt: string
  verified: boolean
  verificationToken?: string
  verificationTokenExpiry?: number
  resetToken?: string
  resetTokenExpiry?: number
  refreshToken?: string
  failedAttempts: number
  lockedUntil?: number
  createdAt: string
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt ?? randomBytes(16).toString('hex')
  const hash = pbkdf2Sync(password, s, 100_000, 64, 'sha512').toString('hex')
  return { hash, salt: s }
}

function verifyPassword(password: string, hash: string, salt: string): boolean {
  const { hash: attempt } = hashPassword(password, salt)
  return attempt === hash
}

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

async function generateAccessToken(userId: string, email: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: userId, email, iat: now, exp: now + 3600 }, secret, 'HS256')
}

// ── Route registrar ───────────────────────────────────────────────────────────

export function mountAuthFlows(app: Hono, spec: ZeroAPISpec): void {
  const config: AuthFlowsConfig = spec.authFlows ?? {}
  const jwtSecret = spec.auth?.secret ?? process.env['JWT_SECRET'] ?? 'dev-secret-change-me'
  const lockout: LockoutConfig = config.lockout ?? { maxAttempts: 5, windowMs: 15 * 60 * 1000 }

  const users = new Map<string, AuthUser>()
  const emailIndex = new Map<string, string>()  // email → userId
  const revokedRefreshTokens = new Set<string>()

  // ── Register ────────────────────────────────────────────────────────────────

  app.post('/auth/register', async (c) => {
    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const email = typeof body['email'] === 'string' ? body['email'].toLowerCase().trim() : null
    const password = typeof body['password'] === 'string' ? body['password'] : null

    if (!email) return c.json({ error: 'email is required' }, 400)
    if (!password) return c.json({ error: 'password is required' }, 400)

    if (emailIndex.has(email)) {
      return c.json({ error: 'Email already registered' }, 409)
    }

    const id = randomBytes(16).toString('hex')
    const { hash, salt } = hashPassword(password)
    const verificationToken = config.emailVerification ? generateToken() : undefined
    const now = new Date().toISOString()

    const user: AuthUser = {
      id,
      email,
      passwordHash: hash,
      salt,
      verified: !config.emailVerification,
      verificationToken,
      verificationTokenExpiry: verificationToken ? Date.now() + 24 * 60 * 60 * 1000 : undefined,
      failedAttempts: 0,
      createdAt: now,
    }

    users.set(id, user)
    emailIndex.set(email, id)

    return c.json({
      data: {
        userId: id,
        email,
        verified: user.verified,
        ...(verificationToken ? { verificationToken } : {}),
      },
    }, 201)
  })

  // ── Email verification ───────────────────────────────────────────────────────

  if (config.emailVerification) {
    app.post('/auth/verify-email', async (c) => {
      let body: Record<string, unknown>
      try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

      const token = typeof body['token'] === 'string' ? body['token'] : null
      if (!token) return c.json({ error: 'token is required' }, 400)

      let found: AuthUser | undefined
      for (const u of users.values()) {
        if (u.verificationToken === token) { found = u; break }
      }

      if (!found) return c.json({ error: 'Invalid verification token' }, 400)
      if (found.verificationTokenExpiry && Date.now() > found.verificationTokenExpiry) {
        return c.json({ error: 'Verification token has expired' }, 400)
      }
      if (found.verified) return c.json({ error: 'Account already verified' }, 400)

      found.verified = true
      found.verificationToken = undefined
      found.verificationTokenExpiry = undefined

      return c.json({ data: { verified: true, email: found.email } })
    })
  }

  // ── Login ────────────────────────────────────────────────────────────────────

  app.post('/auth/login', async (c) => {
    let body: Record<string, unknown>
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const email = typeof body['email'] === 'string' ? body['email'].toLowerCase().trim() : null
    const password = typeof body['password'] === 'string' ? body['password'] : null

    if (!email || !password) return c.json({ error: 'email and password are required' }, 400)

    const userId = emailIndex.get(email)
    const user = userId ? users.get(userId) : undefined

    if (!user) return c.json({ error: 'Invalid email or password' }, 401)

    // Lockout check
    if (user.lockedUntil && Date.now() < user.lockedUntil) {
      return c.json({
        error: 'Account is temporarily locked due to too many failed attempts',
        lockedUntil: new Date(user.lockedUntil).toISOString(),
      }, 423)
    }

    if (!verifyPassword(password, user.passwordHash, user.salt)) {
      user.failedAttempts++
      if (user.failedAttempts >= lockout.maxAttempts) {
        user.lockedUntil = Date.now() + lockout.windowMs
        user.failedAttempts = 0
        return c.json({
          error: 'Account is temporarily locked due to too many failed attempts',
          lockedUntil: new Date(user.lockedUntil).toISOString(),
        }, 423)
      }
      return c.json({ error: 'Invalid email or password' }, 401)
    }

    if (config.emailVerification && !user.verified) {
      return c.json({ error: 'Email not verified' }, 403)
    }

    user.failedAttempts = 0
    user.lockedUntil = undefined

    const accessToken = await generateAccessToken(user.id, user.email, jwtSecret)

    let refreshToken: string | undefined
    if (config.refreshTokens || config.revocation) {
      refreshToken = generateToken()
      if (user.refreshToken) revokedRefreshTokens.add(user.refreshToken)
      user.refreshToken = refreshToken
    }

    return c.json({
      data: {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        userId: user.id,
        email: user.email,
      },
    })
  })

  // ── Forgot password ──────────────────────────────────────────────────────────

  if (config.passwordReset) {
    app.post('/auth/forgot-password', async (c) => {
      let body: Record<string, unknown>
      try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

      const email = typeof body['email'] === 'string' ? body['email'].toLowerCase().trim() : null
      if (!email) return c.json({ error: 'email is required' }, 400)

      const userId = emailIndex.get(email)
      const user = userId ? users.get(userId) : undefined

      // Always return 200 — don't leak whether email exists
      if (!user) return c.json({ data: { message: 'If this email exists, a reset link has been sent' } })

      const resetToken = generateToken()
      user.resetToken = resetToken
      user.resetTokenExpiry = Date.now() + 60 * 60 * 1000  // 1 hour

      return c.json({ data: { message: 'Reset token issued', resetToken } })
    })

    app.post('/auth/reset-password', async (c) => {
      let body: Record<string, unknown>
      try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

      const token = typeof body['token'] === 'string' ? body['token'] : null
      const newPassword = typeof body['newPassword'] === 'string' ? body['newPassword'] : null

      if (!token) return c.json({ error: 'token is required' }, 400)
      if (!newPassword) return c.json({ error: 'newPassword is required' }, 400)

      let found: AuthUser | undefined
      for (const u of users.values()) {
        if (u.resetToken === token) { found = u; break }
      }

      if (!found) return c.json({ error: 'Invalid or expired reset token' }, 400)
      if (!found.resetTokenExpiry || Date.now() > found.resetTokenExpiry) {
        found.resetToken = undefined
        found.resetTokenExpiry = undefined
        return c.json({ error: 'Invalid or expired reset token' }, 400)
      }

      const { hash, salt } = hashPassword(newPassword)
      found.passwordHash = hash
      found.salt = salt
      found.resetToken = undefined
      found.resetTokenExpiry = undefined

      return c.json({ data: { message: 'Password updated successfully' } })
    })
  }

  // ── Refresh token ────────────────────────────────────────────────────────────

  if (config.refreshTokens) {
    app.post('/auth/refresh', async (c) => {
      let body: Record<string, unknown>
      try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

      const refreshToken = typeof body['refreshToken'] === 'string' ? body['refreshToken'] : null
      if (!refreshToken) return c.json({ error: 'refreshToken is required' }, 400)

      if (revokedRefreshTokens.has(refreshToken)) {
        return c.json({ error: 'Refresh token has been revoked' }, 401)
      }

      let found: AuthUser | undefined
      for (const u of users.values()) {
        if (u.refreshToken === refreshToken) { found = u; break }
      }

      if (!found) return c.json({ error: 'Invalid refresh token' }, 401)

      // Rotate: revoke old, issue new
      revokedRefreshTokens.add(refreshToken)
      const newRefreshToken = generateToken()
      found.refreshToken = newRefreshToken

      const accessToken = await generateAccessToken(found.id, found.email, jwtSecret)

      return c.json({ data: { accessToken, refreshToken: newRefreshToken } })
    })
  }

  // ── Logout / revocation ──────────────────────────────────────────────────────

  if (config.revocation) {
    app.post('/auth/logout', async (c) => {
      let body: Record<string, unknown>
      try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

      const refreshToken = typeof body['refreshToken'] === 'string' ? body['refreshToken'] : null
      if (!refreshToken) return c.json({ error: 'refreshToken is required' }, 400)

      let found: AuthUser | undefined
      for (const u of users.values()) {
        if (u.refreshToken === refreshToken) { found = u; break }
      }

      if (found) {
        found.refreshToken = undefined
        revokedRefreshTokens.add(refreshToken)
      }

      return c.json({ data: { message: 'Logged out successfully' } })
    })
  }
}
