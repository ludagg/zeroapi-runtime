import type { Hono, Context } from 'hono'
import { verifySignature } from './signature.js'

export interface InboundEventRecord {
  id: string
  source: string
  receivedAt: Date
  headers: Record<string, string>
  payload: unknown
}

/**
 * In-memory log of inbound webhook events. Useful for tests and for the
 * `GET /webhooks/inbound/:source/recent` debug endpoint, which the runtime
 * does NOT mount automatically (debugging only — opt-in).
 */
export class InboundEventLog {
  private readonly events: InboundEventRecord[] = []
  constructor(public readonly maxEntries: number = 100) {}

  add(record: InboundEventRecord): void {
    this.events.unshift(record)
    while (this.events.length > this.maxEntries) this.events.pop()
  }

  recent(source?: string): InboundEventRecord[] {
    if (!source) return [...this.events]
    return this.events.filter((e) => e.source === source)
  }
}

export interface InboundSourceConfig {
  /** Source slug as it appears in the URL — e.g. `"stripe"`. */
  source: string
  /**
   * Env var holding the shared secret used to verify the provider's signature.
   * When the var is not set the endpoint still accepts requests but logs a
   * warning at boot — useful in dev. In production, missing secret → 401.
   */
  secretEnv?: string
  /**
   * HTTP header that carries the signature. Defaults to
   * `X-Webhook-Signature`. Stripe uses `Stripe-Signature`, GitHub uses
   * `X-Hub-Signature-256`, etc.
   */
  signatureHeader?: string
  /**
   * Optional transform applied to the raw header value before HMAC compare.
   * Stripe ships values like `t=...,v1=<hex>`; the resolver returns the hex.
   * Default: identity (use the header value as-is).
   */
  extractSignature?: (headerValue: string) => string | null
}

export interface InboundRoutesOptions {
  /** Receives `(level, message, extra)` log lines. Defaults to a no-op. */
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void
  /** Sink for accepted inbound events (kept in memory by default). */
  eventLog?: InboundEventLog
  /**
   * Optional handler invoked for every accepted inbound event. Runs *after* the
   * 200 response is sent (fire-and-forget). Throwing has no effect on the HTTP
   * status — the provider already got their ack.
   */
  onEvent?: (record: InboundEventRecord) => void | Promise<void>
}

/** Convert a Stripe-style `t=...,v1=<hex>` value to just the hex part. */
function defaultExtract(value: string): string {
  return value
}

/**
 * Mounts `POST /webhooks/inbound/:source` for every configured source.
 *
 * - Reads the raw body (signature must match the bytes the provider sent).
 * - Verifies the HMAC signature when a secret is configured for that source.
 * - Stores the event in the in-memory log + calls `onEvent` (if provided).
 * - Responds 200 immediately (providers expect a fast ack).
 *
 * Inbound routes are NOT gated by the global API auth — providers can't carry
 * our tokens. The signature IS the auth.
 */
export function mountWebhookInboundRoutes(
  app: Hono,
  sources: InboundSourceConfig[],
  options: InboundRoutesOptions = {},
): void {
  const log = options.log ?? (() => { /* no-op */ })
  const eventLog = options.eventLog ?? new InboundEventLog()
  const onEvent = options.onEvent

  // Build a quick lookup so the route handler can find its source config.
  const byName = new Map<string, InboundSourceConfig>()
  for (const s of sources) byName.set(s.source, s)

  // Warn at boot when secrets are expected but missing — outside of test.
  if (process.env['NODE_ENV'] !== 'test') {
    for (const s of sources) {
      if (s.secretEnv && !process.env[s.secretEnv]) {
        log('warn', `inbound webhook source "${s.source}" has no signing secret`, {
          envVar: s.secretEnv,
        })
      }
    }
  }

  app.post('/webhooks/inbound/:source', async (c: Context) => {
    const source = c.req.param('source') ?? ''
    const config = source ? byName.get(source) : undefined
    if (!config) return c.json({ error: 'Unknown webhook source' }, 404)

    let raw = ''
    try { raw = await c.req.text() } catch { /* empty body is fine */ }

    let payload: unknown = null
    if (raw.length > 0) {
      try { payload = JSON.parse(raw) }
      catch { payload = raw }   // some providers send form-encoded; keep the raw string.
    }

    const secret = config.secretEnv ? process.env[config.secretEnv] : undefined
    const headerName = (config.signatureHeader ?? 'x-webhook-signature').toLowerCase()
    const headerValue = c.req.header(headerName) ?? null

    if (secret) {
      const extract = config.extractSignature ?? defaultExtract
      const sig = headerValue !== null ? extract(headerValue) : null
      if (!verifySignature(secret, raw, sig)) {
        log('warn', 'inbound webhook rejected (bad signature)', { source })
        return c.json({ error: 'Invalid signature' }, 401)
      }
    } else if (config.secretEnv && process.env['NODE_ENV'] === 'production') {
      // Signing secret expected but missing in production — refuse the event.
      log('error', 'inbound webhook secret missing in production', {
        source, envVar: config.secretEnv,
      })
      return c.json({ error: 'Webhook secret not configured' }, 401)
    }

    const headers: Record<string, string> = {}
    for (const key of ['content-type', headerName, 'user-agent']) {
      const v = c.req.header(key)
      if (v) headers[key] = v
    }

    const record: InboundEventRecord = {
      id: crypto.randomUUID(),
      source,
      receivedAt: new Date(),
      headers,
      payload,
    }
    eventLog.add(record)
    log('info', 'inbound webhook received', { source, id: record.id })

    // Fire-and-forget user handler — never blocks the ack.
    if (onEvent) {
      Promise.resolve()
        .then(() => onEvent(record))
        .catch((err) => log('error', 'inbound webhook handler threw', {
          source, id: record.id, error: String(err),
        }))
    }

    return c.json({ received: true, id: record.id }, 200)
  })
}
