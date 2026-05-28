import { createHmac, timingSafeEqual, randomBytes } from 'crypto'

export const SIGNATURE_HEADER = 'x-webhook-signature'
export const EVENT_TYPE_HEADER = 'x-webhook-event'
export const EVENT_ID_HEADER = 'x-webhook-id'

/**
 * HMAC-SHA256 of `body` with `secret`, hex-encoded. Stripe and most providers
 * use this same primitive (only the header name + payload framing differ).
 */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

/**
 * Constant-time signature check. Returns `false` for malformed or missing
 * inputs; never throws. Use this on inbound webhooks.
 */
export function verifySignature(secret: string, body: string, signature: string | null | undefined): boolean {
  if (!signature) return false
  const expected = signPayload(secret, body)
  // Both buffers must be the same length for timingSafeEqual.
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  if (a.length !== b.length) return false
  try { return timingSafeEqual(a, b) } catch { return false }
}

const SECRET_PREFIX = 'whsec_'

/** Generates a 256-bit random secret for a new endpoint. */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('hex')
}
