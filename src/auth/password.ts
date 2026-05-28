import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto'

export interface PasswordHash {
  hash: string
  salt: string
}

const ITERATIONS = 100_000
const KEY_LENGTH = 64
const DIGEST = 'sha512'
const SALT_BYTES = 16

/**
 * PBKDF2-SHA512 password hash with a per-user random salt. Returns both halves
 * so the caller can persist them side-by-side and re-derive at verify time.
 */
export function hashPassword(password: string, salt?: string): PasswordHash {
  const s = salt ?? randomBytes(SALT_BYTES).toString('hex')
  const hash = pbkdf2Sync(password, s, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex')
  return { hash, salt: s }
}

/**
 * Constant-time password verification. Re-derives the candidate hash with the
 * stored salt then `timingSafeEqual`s against the stored hash — no early exit.
 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const attempt = hashPassword(password, salt).hash
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(attempt, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
