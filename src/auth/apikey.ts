import crypto from 'crypto'

export interface GeneratedApiKey {
  /** Plaintext key — only available at generation time. */
  key: string
  /** SHA-256 hex digest of the plaintext key — safe to store. */
  keyHash: string
  /** Short identifying prefix of the key — safe to display. */
  keyPrefix: string
}

/**
 * Generates a fresh API key. The plaintext value is returned ONCE and must be
 * surfaced to the operator immediately — only the hash is meant to be persisted.
 */
export function generateApiKey(prefix = 'zak_live_'): GeneratedApiKey {
  const raw = crypto.randomBytes(32).toString('hex')
  const key = prefix + raw
  const keyHash = hashApiKey(key)
  const keyPrefix = key.slice(0, 16)
  return { key, keyHash, keyPrefix }
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}
