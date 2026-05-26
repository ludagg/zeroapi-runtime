import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

// ── Shared spec ───────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<ZeroAPISpec['authFlows']> = {}): ZeroAPISpec {
  return {
    version: '1.0.0',
    name: 'auth-flows-test',
    resources: [],
    auth: { strategy: 'jwt', secret: 'test-secret-for-auth-flows' },
    authFlows: {
      emailVerification: true,
      passwordReset: true,
      refreshTokens: true,
      revocation: true,
      lockout: { maxAttempts: 3, windowMs: 60_000 },
      ...overrides,
    },
  }
}

const opts = {
  enableLogging: false, enableDocs: false,
  enableHelmet: false, enableCors: false, enableSanitize: false,
}

async function register(app: ReturnType<typeof createRuntime>['app'], email: string, password: string) {
  const res = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res
}

async function login(app: ReturnType<typeof createRuntime>['app'], email: string, password: string) {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res
}

// ── Registration ──────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('returns 201 with userId and verificationToken', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    const res = await register(app, 'alice@example.com', 'pass1234')
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { userId: string; verificationToken: string; verified: boolean } }
    expect(typeof data.userId).toBe('string')
    expect(data.userId.length).toBeGreaterThan(0)
    expect(typeof data.verificationToken).toBe('string')
    expect(data.verificationToken.length).toBeGreaterThan(0)
    expect(data.verified).toBe(false)
  })

  it('returns 409 when registering the same email twice', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    await register(app, 'bob@example.com', 'password')
    const second = await register(app, 'bob@example.com', 'other-password')
    expect(second.status).toBe(409)
    const { error } = await second.json() as { error: string }
    expect(error).toContain('already registered')
  })

  it('returns 400 when email is missing', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pass1234' }),
    })
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('email')
  })

  it('returns 400 when password is missing', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    })
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('password')
  })

  it('without emailVerification flag, user is created as verified:true', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    const res = await register(app, 'carol@example.com', 'pass1234')
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { verified: boolean; verificationToken?: string } }
    expect(data.verified).toBe(true)
    expect(data.verificationToken).toBeUndefined()
  })
})

// ── Email verification ────────────────────────────────────────────────────────

describe('POST /auth/verify-email', () => {
  it('verifies account with valid token — returns verified:true', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    const regRes = await register(app, 'dave@example.com', 'pass1234')
    const { data: { verificationToken } } = await regRes.json() as { data: { verificationToken: string } }

    const verRes = await app.request('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verificationToken }),
    })
    expect(verRes.status).toBe(200)
    const { data } = await verRes.json() as { data: { verified: boolean; email: string } }
    expect(data.verified).toBe(true)
    expect(data.email).toBe('dave@example.com')
  })

  it('returns 400 for an invalid token', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    const res = await app.request('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token' }),
    })
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('Invalid')
  })

  it('token can only be used once — second use returns 400', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    const regRes = await register(app, 'eve@example.com', 'pass1234')
    const { data: { verificationToken } } = await regRes.json() as { data: { verificationToken: string } }

    await app.request('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verificationToken }),
    })
    const second = await app.request('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verificationToken }),
    })
    expect(second.status).toBe(400)
  })
})

// ── Login ─────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('returns accessToken and refreshToken on correct credentials (verified user)', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    const regRes = await register(app, 'frank@example.com', 'pass1234')
    const { data: { verificationToken } } = await regRes.json() as { data: { verificationToken: string } }
    await app.request('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verificationToken }),
    })

    const loginRes = await login(app, 'frank@example.com', 'pass1234')
    expect(loginRes.status).toBe(200)
    const { data } = await loginRes.json() as { data: { accessToken: string; refreshToken: string; userId: string } }
    expect(typeof data.accessToken).toBe('string')
    expect(data.accessToken.split('.').length).toBe(3)  // valid JWT structure
    expect(typeof data.refreshToken).toBe('string')
    expect(data.refreshToken.length).toBeGreaterThan(0)
    expect(typeof data.userId).toBe('string')
  })

  it('returns 401 for wrong password', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    await register(app, 'grace@example.com', 'correct-pass')

    const res = await login(app, 'grace@example.com', 'wrong-pass')
    expect(res.status).toBe(401)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('Invalid')
  })

  it('returns 401 for non-existent email', async () => {
    const { app } = createRuntime(makeSpec(), opts)
    const res = await login(app, 'nobody@example.com', 'any-pass')
    expect(res.status).toBe(401)
  })

  it('returns 403 when email not verified', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: true }), opts)
    await register(app, 'heidi@example.com', 'pass1234')
    // Do NOT verify email
    const res = await login(app, 'heidi@example.com', 'pass1234')
    expect(res.status).toBe(403)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('verified')
  })

  it('locks account after maxAttempts failed logins — returns 423', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false, lockout: { maxAttempts: 3, windowMs: 60_000 } }), opts)
    await register(app, 'ivan@example.com', 'correct')

    // 3 wrong attempts
    await login(app, 'ivan@example.com', 'wrong')
    await login(app, 'ivan@example.com', 'wrong')
    const res = await login(app, 'ivan@example.com', 'wrong')
    expect(res.status).toBe(423)
    const { error, lockedUntil } = await res.json() as { error: string; lockedUntil: string }
    expect(error).toContain('locked')
    expect(typeof lockedUntil).toBe('string')
    expect(new Date(lockedUntil).getTime()).toBeGreaterThan(Date.now())
  })

  it('locked account stays locked even with correct password', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false, lockout: { maxAttempts: 2, windowMs: 60_000 } }), opts)
    await register(app, 'judy@example.com', 'correct')

    await login(app, 'judy@example.com', 'wrong')
    await login(app, 'judy@example.com', 'wrong')

    // Now try correct password — still locked
    const res = await login(app, 'judy@example.com', 'correct')
    expect(res.status).toBe(423)
  })

  it('successful login resets failed attempt counter', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false, lockout: { maxAttempts: 3, windowMs: 60_000 } }), opts)
    await register(app, 'kate@example.com', 'correct')

    // 2 wrong attempts (below limit)
    await login(app, 'kate@example.com', 'wrong')
    await login(app, 'kate@example.com', 'wrong')

    // Correct login resets counter
    const good = await login(app, 'kate@example.com', 'correct')
    expect(good.status).toBe(200)

    // Now 3 more wrong attempts should lock (counter was reset to 0)
    await login(app, 'kate@example.com', 'wrong')
    await login(app, 'kate@example.com', 'wrong')
    const locked = await login(app, 'kate@example.com', 'wrong')
    expect(locked.status).toBe(423)
  })
})

// ── Password reset ────────────────────────────────────────────────────────────

describe('POST /auth/forgot-password + /auth/reset-password', () => {
  it('forgot-password returns 200 with resetToken for known email', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    await register(app, 'liam@example.com', 'pass1234')

    const res = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'liam@example.com' }),
    })
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: { resetToken: string } }
    expect(typeof data.resetToken).toBe('string')
    expect(data.resetToken.length).toBeGreaterThan(0)
  })

  it('forgot-password returns 200 for unknown email — no info leak', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    const res = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com' }),
    })
    expect(res.status).toBe(200)
  })

  it('reset-password with valid token sets new password', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    await register(app, 'mia@example.com', 'old-pass')

    const fpRes = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mia@example.com' }),
    })
    const { data: { resetToken } } = await fpRes.json() as { data: { resetToken: string } }

    const resetRes = await app.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: 'new-pass' }),
    })
    expect(resetRes.status).toBe(200)

    // Can now login with new password
    const loginRes = await login(app, 'mia@example.com', 'new-pass')
    expect(loginRes.status).toBe(200)
  })

  it('old password no longer works after reset', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    await register(app, 'noah@example.com', 'old-pass')

    const fpRes = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noah@example.com' }),
    })
    const { data: { resetToken } } = await fpRes.json() as { data: { resetToken: string } }

    await app.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: 'new-pass' }),
    })

    const oldLoginRes = await login(app, 'noah@example.com', 'old-pass')
    expect(oldLoginRes.status).toBe(401)
  })

  it('reset-password with invalid token returns 400', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    const res = await app.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bogus-token', newPassword: 'whatever' }),
    })
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('Invalid')
  })
})

// ── Refresh token rotation ────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  it('returns new accessToken and refreshToken on valid refresh token', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    await register(app, 'olivia@example.com', 'pass1234')
    const { data: { refreshToken: rt } } = await (await login(app, 'olivia@example.com', 'pass1234')).json() as { data: { refreshToken: string } }

    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    })
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: { accessToken: string; refreshToken: string } }
    expect(typeof data.accessToken).toBe('string')
    expect(data.accessToken.split('.').length).toBe(3)
    expect(typeof data.refreshToken).toBe('string')
    expect(data.refreshToken).not.toBe(rt)  // rotated
  })

  it('old refresh token is rejected after rotation', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    await register(app, 'peter@example.com', 'pass1234')
    const { data: { refreshToken: original } } = await (await login(app, 'peter@example.com', 'pass1234')).json() as { data: { refreshToken: string } }

    // Rotate
    await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: original }),
    })

    // Use original again — must fail
    const second = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: original }),
    })
    expect(second.status).toBe(401)
  })

  it('returns 401 for an invalid refresh token', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'not-a-real-token' }),
    })
    expect(res.status).toBe(401)
  })
})

// ── Logout / revocation ───────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  it('returns 200 on successful logout', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    await register(app, 'quinn@example.com', 'pass1234')
    const { data: { refreshToken } } = await (await login(app, 'quinn@example.com', 'pass1234')).json() as { data: { refreshToken: string } }

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: { message: string } }
    expect(data.message).toContain('Logged out')
  })

  it('refresh token is rejected after logout', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    await register(app, 'rose@example.com', 'pass1234')
    const { data: { refreshToken } } = await (await login(app, 'rose@example.com', 'pass1234')).json() as { data: { refreshToken: string } }

    await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })

    // Attempting refresh after logout → 401
    const refreshRes = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    expect(refreshRes.status).toBe(401)
  })

  it('logout with unknown refresh token still returns 200 (idempotent)', async () => {
    const { app } = createRuntime(makeSpec({ emailVerification: false }), opts)
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'completely-made-up' }),
    })
    expect(res.status).toBe(200)
  })
})
