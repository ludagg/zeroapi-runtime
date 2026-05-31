import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

/** Env var holding the webhook-secret encryption key (any string; a 32-byte AES
 *  key is derived from it via SHA-256). When unset, secrets are stored in clear. */
export const WEBHOOK_SECRET_ENCRYPTION_KEY_ENV = 'WEBHOOK_SECRET_ENCRYPTION_KEY'

/** Self-describing prefix marking an encrypted value. Anything without it is
 *  treated as a legacy plaintext secret (so existing rows keep working). */
const PREFIX = 'enc:v1:'

/**
 * Reversible cipher for webhook signing secrets (AES-256-GCM). Unlike the
 * one-way hashes used for passwords / API keys, webhook secrets must be
 * recoverable to compute the HMAC signature at delivery time — hence symmetric
 * encryption rather than hashing.
 */
export interface WebhookSecretCipher {
  /** Encrypt a plaintext secret → `enc:v1:<iv>:<tag>:<ciphertext>` (all hex). */
  encrypt(plaintext: string): string
  /**
   * Decrypt a stored secret. A value WITHOUT the `enc:v1:` prefix is returned
   * unchanged — legacy plaintext secrets keep working with no migration.
   */
  decrypt(stored: string): string
}

/**
 * Builds an AES-256-GCM cipher from an arbitrary key string (the 32-byte key is
 * derived via SHA-256, so any length works). GCM gives confidentiality AND
 * integrity (auth tag), so a tampered ciphertext fails to decrypt rather than
 * silently producing garbage.
 */
export function createWebhookSecretCipher(key: string): WebhookSecretCipher {
  const keyBuf = createHash('sha256').update(key, 'utf8').digest() // 32 bytes

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', keyBuf, iv)
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
    },

    decrypt(stored: string): string {
      // Legacy plaintext (no prefix) → return as-is. Backward compatible.
      if (!stored.startsWith(PREFIX)) return stored
      const [ivHex, tagHex, ctHex] = stored.slice(PREFIX.length).split(':')
      if (!ivHex || !tagHex || !ctHex) return stored // malformed — leave untouched
      const decipher = createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivHex, 'hex'))
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
      const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()])
      return pt.toString('utf8')
    },
  }
}

/** True when a stored value is an `enc:v1:` ciphertext (used by tests / audits). */
export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX)
}
