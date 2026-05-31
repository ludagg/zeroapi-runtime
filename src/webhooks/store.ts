import { randomUUID } from 'crypto'
import type { WebhookSecretCipher } from './secret-cipher.js'

/**
 * Persisted endpoint subscription. The secret is stored in the clear so it can
 * be re-used to sign each delivery — it is only ever returned to clients ONCE,
 * at creation time, via the admin route.
 */
export interface WebhookEndpointRecord {
  id: string
  url: string
  /** CSV of event types this endpoint subscribes to. */
  events: string
  secret: string
  active: boolean
  createdAt: Date
}

export interface CreateWebhookEndpointInput {
  url: string
  events: string[]
  secret: string
}

export type WebhookEventStatus = 'pending' | 'delivered' | 'failed'

/**
 * Persisted delivery attempt. The worker walks this table, ships the payload
 * to the endpoint, and writes back `status` / `attempts` / `nextRetryAt` /
 * `lastError` until the row is either delivered or exhausts `maxAttempts`.
 */
export interface WebhookEventRecord {
  id: string
  endpointId: string
  eventType: string
  payload: unknown
  status: WebhookEventStatus
  attempts: number
  maxAttempts: number
  nextRetryAt: Date | null
  lastError: string | null
  lockedAt: Date | null
  lockedBy: string | null
  createdAt: Date
  deliveredAt: Date | null
}

export interface CreateWebhookEventInput {
  endpointId: string
  eventType: string
  payload: unknown
  maxAttempts?: number
}

export interface ClaimEventsOptions {
  /** Worker identifier — written to `lockedBy` so we can audit stuck rows. */
  workerId: string
  /** Max rows the worker is willing to process per tick. */
  batchSize: number
  /** Current time (injectable for tests). Defaults to `Date.now()`. */
  now?: Date
  /** Lock TTL — events whose lock is older than this are reclaimable. */
  lockTtlMs?: number
}

export interface UpdateAfterAttemptInput {
  id: string
  status: WebhookEventStatus
  attempts: number
  nextRetryAt: Date | null
  lastError: string | null
  deliveredAt: Date | null
}

/**
 * Storage abstraction for webhooks (endpoints + delivery events). The
 * `MemoryWebhookStore` is the default for dev/test; a Prisma-backed
 * implementation is provided for production.
 */
export interface WebhookStore {
  // ── Endpoints ────────────────────────────────────────────────────────────
  createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookEndpointRecord>
  listEndpoints(): Promise<WebhookEndpointRecord[]>
  getEndpoint(id: string): Promise<WebhookEndpointRecord | null>
  deleteEndpoint(id: string): Promise<boolean>
  /** Endpoints subscribed to a given event type (only active rows). */
  findActiveEndpointsForEvent(eventType: string): Promise<WebhookEndpointRecord[]>

  // ── Events ───────────────────────────────────────────────────────────────
  createEvent(input: CreateWebhookEventInput): Promise<WebhookEventRecord>
  /** Atomically locks and returns events ready for delivery. */
  claimReadyEvents(options: ClaimEventsOptions): Promise<WebhookEventRecord[]>
  /** Persist the outcome of a delivery attempt. Also clears the lock. */
  updateAfterAttempt(input: UpdateAfterAttemptInput): Promise<void>
  /** Delivery history for one endpoint (most-recent first). */
  listEventsForEndpoint(endpointId: string, limit?: number): Promise<WebhookEventRecord[]>
  /** Internal-use: read a single event by id. */
  getEvent(id: string): Promise<WebhookEventRecord | null>
}

// ── Memory implementation ────────────────────────────────────────────────────

const DEFAULT_LOCK_TTL_MS = 2 * 60 * 1000

function parseEventsCsv(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Process-local store. Loses everything on restart — fine for dev / tests. */
export class MemoryWebhookStore implements WebhookStore {
  private readonly endpoints = new Map<string, WebhookEndpointRecord>()
  private readonly events = new Map<string, WebhookEventRecord>()

  /** Optional cipher: when present the `secret` is stored encrypted at rest and
   *  decrypted on read. When absent, secrets are stored in clear (the default). */
  constructor(private readonly cipher?: WebhookSecretCipher) {}

  /** Decrypt the stored secret on the way out (no-op without a cipher). */
  private reveal(record: WebhookEndpointRecord): WebhookEndpointRecord {
    if (!this.cipher) return record
    return { ...record, secret: this.cipher.decrypt(record.secret) }
  }

  async createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookEndpointRecord> {
    const record: WebhookEndpointRecord = {
      id: randomUUID(),
      url: input.url,
      events: input.events.join(','),
      // Encrypt at rest when a cipher is configured.
      secret: this.cipher ? this.cipher.encrypt(input.secret) : input.secret,
      active: true,
      createdAt: new Date(),
    }
    this.endpoints.set(record.id, record)
    // Return the PLAINTEXT secret (shown once at creation), never the ciphertext.
    return { ...record, secret: input.secret }
  }

  async listEndpoints(): Promise<WebhookEndpointRecord[]> {
    return [...this.endpoints.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => this.reveal(r))
  }

  async getEndpoint(id: string): Promise<WebhookEndpointRecord | null> {
    const r = this.endpoints.get(id)
    return r ? this.reveal(r) : null
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    return this.endpoints.delete(id)
  }

  async findActiveEndpointsForEvent(eventType: string): Promise<WebhookEndpointRecord[]> {
    const out: WebhookEndpointRecord[] = []
    for (const ep of this.endpoints.values()) {
      if (!ep.active) continue
      const events = parseEventsCsv(ep.events)
      if (events.includes(eventType) || events.includes('*')) out.push(this.reveal(ep))
    }
    return out
  }

  async createEvent(input: CreateWebhookEventInput): Promise<WebhookEventRecord> {
    const record: WebhookEventRecord = {
      id: randomUUID(),
      endpointId: input.endpointId,
      eventType: input.eventType,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      nextRetryAt: null,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: new Date(),
      deliveredAt: null,
    }
    this.events.set(record.id, record)
    return record
  }

  async claimReadyEvents(options: ClaimEventsOptions): Promise<WebhookEventRecord[]> {
    const now = options.now ?? new Date()
    const lockTtl = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
    const lockExpiry = new Date(now.getTime() - lockTtl)

    const claimed: WebhookEventRecord[] = []
    for (const event of this.events.values()) {
      if (claimed.length >= options.batchSize) break
      if (event.attempts >= event.maxAttempts) continue
      if (event.status === 'delivered') continue
      // Ready when: pending OR (failed AND nextRetryAt <= now)
      const ready =
        event.status === 'pending' ||
        (event.status === 'failed' && event.nextRetryAt !== null && event.nextRetryAt.getTime() <= now.getTime())
      if (!ready) continue
      // Skip if locked AND the lock is still fresh.
      if (event.lockedAt && event.lockedAt.getTime() > lockExpiry.getTime()) continue

      event.lockedAt = new Date(now.getTime())
      event.lockedBy = options.workerId
      claimed.push({ ...event })
    }
    return claimed
  }

  async updateAfterAttempt(input: UpdateAfterAttemptInput): Promise<void> {
    const event = this.events.get(input.id)
    if (!event) return
    event.status = input.status
    event.attempts = input.attempts
    event.nextRetryAt = input.nextRetryAt
    event.lastError = input.lastError
    event.deliveredAt = input.deliveredAt
    event.lockedAt = null
    event.lockedBy = null
  }

  async listEventsForEndpoint(endpointId: string, limit = 100): Promise<WebhookEventRecord[]> {
    return [...this.events.values()]
      .filter((e) => e.endpointId === endpointId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  }

  async getEvent(id: string): Promise<WebhookEventRecord | null> {
    const ev = this.events.get(id)
    return ev ? { ...ev } : null
  }
}
