import crypto from 'crypto'
import { sign, verify } from 'hono/jwt'
import type { GlobalAuthConfig } from '../types/spec.js'

export interface JwtPayload {
  sub: string
  email: string
  role: string
  iat: number
  exp: number
  /** RFC 7519 unique token id — guarantees per-token uniqueness even when two
   *  tokens are issued in the same second with otherwise identical claims. */
  jti: string
}

export type JwtSecretLogger = (line: string) => void

const DEFAULT_ACCESS_TTL_SEC = 15 * 60          // 15 minutes
const DEFAULT_REFRESH_TTL_SEC = 7 * 24 * 60 * 60 // 7 days
const REFRESH_BYTES = 48

/**
 * Parses a TTL string ("15m", "7d", "3600s", "2h") into seconds. Unsuffixed
 * numbers are treated as seconds. Falls back to `fallbackSec` on invalid input.
 */
export function parseTTL(raw: string | undefined, fallbackSec: number): number {
  if (!raw) return fallbackSec
  const m = /^(\d+)([smhd]?)$/.exec(raw.trim())
  if (!m) return fallbackSec
  const n = parseInt(m[1]!, 10)
  switch (m[2]) {
    case 's': case '': return n
    case 'm': return n * 60
    case 'h': return n * 60 * 60
    case 'd': return n * 24 * 60 * 60
    default: return fallbackSec
  }
}

export function getAccessTokenTTL(config: GlobalAuthConfig): number {
  return parseTTL(config.jwt?.accessTokenTTL, DEFAULT_ACCESS_TTL_SEC)
}

export function getRefreshTokenTTL(config: GlobalAuthConfig): number {
  return parseTTL(config.jwt?.refreshTokenTTL, DEFAULT_REFRESH_TTL_SEC)
}

export function getJwtSecretEnvName(config: GlobalAuthConfig): string {
  return config.jwt?.secretEnv ?? 'JWT_SECRET'
}

/**
 * Resolves the JWT signing secret with a fail-closed posture:
 *   - read `process.env[secretEnv]`; if set, use it.
 *   - in production (`NODE_ENV=production`) without a value, throw.
 *   - in dev/test, generate a one-shot ephemeral secret and warn — so the
 *     app boots but every restart invalidates outstanding tokens.
 */
export function resolveJwtSecret(
  config: GlobalAuthConfig,
  log: JwtSecretLogger = (l) => console.warn(l),
): string {
  const envName = getJwtSecretEnvName(config)
  const fromEnv = process.env[envName]
  if (fromEnv && fromEnv.length > 0) return fromEnv

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      `ZeroAPI: auth.jwt is enabled in production but ${envName} is not set. ` +
      `Set ${envName} to a long random secret. Refusing to start with an ephemeral secret.`
    )
  }

  const ephemeral = crypto.randomBytes(48).toString('hex')
  log(`⚠️  ZeroAPI — ${envName} is not set; generated an EPHEMERAL JWT secret for this process. ` +
      `Tokens are invalidated on restart. Set ${envName} before deploying.`)
  return ephemeral
}

export async function generateAccessToken(
  userId: string,
  email: string,
  role: string,
  secret: string,
  ttlSec: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: userId, email, role, iat: now, exp: now + ttlSec,
    jti: crypto.randomUUID(),
  }
  return sign(payload, secret, 'HS256')
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
  try {
    const decoded = (await verify(token, secret, 'HS256')) as Record<string, unknown>
    if (
      typeof decoded['sub'] !== 'string' ||
      typeof decoded['email'] !== 'string' ||
      typeof decoded['role'] !== 'string' ||
      typeof decoded['iat'] !== 'number' ||
      typeof decoded['exp'] !== 'number' ||
      typeof decoded['jti'] !== 'string'
    ) return null
    return decoded as unknown as JwtPayload
  } catch {
    return null
  }
}

export function generateRefreshTokenValue(): string {
  return crypto.randomBytes(REFRESH_BYTES).toString('hex')
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}
