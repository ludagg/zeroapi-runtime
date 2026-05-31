import type {
  WebhookStore,
  WebhookEndpointRecord,
  WebhookEventRecord,
  WebhookEventStatus,
  CreateWebhookEndpointInput,
  CreateWebhookEventInput,
  ClaimEventsOptions,
  UpdateAfterAttemptInput,
} from './store.js'

const DEFAULT_LOCK_TTL_MS = 2 * 60 * 1000

// ── Structural Prisma shapes ──────────────────────────────────────────────────
// Structural (not importing `@prisma/client`) so this package keeps Prisma as an
// optional peer — any generated client whose `webhookEndpoint` / `webhookEvent`
// delegates match the schema in `src/webhooks/schema.ts` satisfies these.

export interface PrismaWebhookEndpointRow {
  id: string
  url: string
  events: string
  secret: string
  active: boolean
  createdAt: Date
}

export interface PrismaWebhookEventRow {
  id: string
  endpointId: string
  eventType: string
  payload: unknown
  status: string
  attempts: number
  maxAttempts: number
  nextRetryAt: Date | null
  lastError: string | null
  lockedAt: Date | null
  lockedBy: string | null
  createdAt: Date
  deliveredAt: Date | null
}

export interface PrismaWebhookEndpointDelegate {
  create(args: { data: Record<string, unknown> }): Promise<PrismaWebhookEndpointRow>
  findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> }): Promise<PrismaWebhookEndpointRow[]>
  findUnique(args: { where: { id: string } }): Promise<PrismaWebhookEndpointRow | null>
  delete(args: { where: { id: string } }): Promise<PrismaWebhookEndpointRow>
}

export interface PrismaWebhookEventDelegate {
  create(args: { data: Record<string, unknown> }): Promise<PrismaWebhookEventRow>
  findMany(args?: {
    where?: Record<string, unknown>
    orderBy?: Record<string, 'asc' | 'desc'>
    take?: number
  }): Promise<PrismaWebhookEventRow[]>
  findUnique(args: { where: { id: string } }): Promise<PrismaWebhookEventRow | null>
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<PrismaWebhookEventRow>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

export interface PrismaWebhookLikeClient {
  webhookEndpoint: PrismaWebhookEndpointDelegate
  webhookEvent: PrismaWebhookEventDelegate
}

function parseEventsCsv(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean)
}

function toEndpointRecord(r: PrismaWebhookEndpointRow): WebhookEndpointRecord {
  return {
    id: r.id,
    url: r.url,
    events: r.events,
    secret: r.secret,
    active: r.active,
    createdAt: r.createdAt,
  }
}

function toEventRecord(r: PrismaWebhookEventRow): WebhookEventRecord {
  return {
    id: r.id,
    endpointId: r.endpointId,
    eventType: r.eventType,
    payload: r.payload,
    status: r.status as WebhookEventStatus,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    nextRetryAt: r.nextRetryAt,
    lastError: r.lastError,
    lockedAt: r.lockedAt,
    lockedBy: r.lockedBy,
    createdAt: r.createdAt,
    deliveredAt: r.deliveredAt,
  }
}

/**
 * Prisma-backed {@link WebhookStore}. Persists endpoints + delivery events to the
 * database so subscriptions and the delivery queue survive restarts and work
 * across instances — the production counterpart to {@link MemoryWebhookStore}.
 *
 * The lock in `claimReadyEvents` is enforced by an atomic `updateMany` whose
 * WHERE re-checks the lock guard: Postgres row-locking lets exactly one worker
 * win each row, so concurrent workers never deliver the same event twice.
 */
export class PrismaWebhookStore implements WebhookStore {
  constructor(private readonly client: PrismaWebhookLikeClient) {}

  // ── Endpoints ──────────────────────────────────────────────────────────────

  async createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookEndpointRecord> {
    const row = await this.client.webhookEndpoint.create({
      data: { url: input.url, events: input.events.join(','), secret: input.secret, active: true },
    })
    return toEndpointRecord(row)
  }

  async listEndpoints(): Promise<WebhookEndpointRecord[]> {
    const rows = await this.client.webhookEndpoint.findMany({ orderBy: { createdAt: 'desc' } })
    return rows.map(toEndpointRecord)
  }

  async getEndpoint(id: string): Promise<WebhookEndpointRecord | null> {
    const row = await this.client.webhookEndpoint.findUnique({ where: { id } })
    return row ? toEndpointRecord(row) : null
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    try {
      await this.client.webhookEndpoint.delete({ where: { id } })
      return true
    } catch {
      return false
    }
  }

  async findActiveEndpointsForEvent(eventType: string): Promise<WebhookEndpointRecord[]> {
    // Fetch active endpoints and match the CSV in JS — a SQL substring match on
    // the CSV column would risk false positives (e.g. "user.create" ⊂ "user.created").
    const rows = await this.client.webhookEndpoint.findMany({ where: { active: true } })
    return rows
      .filter((r) => {
        const events = parseEventsCsv(r.events)
        return events.includes(eventType) || events.includes('*')
      })
      .map(toEndpointRecord)
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  async createEvent(input: CreateWebhookEventInput): Promise<WebhookEventRecord> {
    const row = await this.client.webhookEvent.create({
      data: {
        endpointId: input.endpointId,
        eventType: input.eventType,
        payload: input.payload as never,
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      },
    })
    return toEventRecord(row)
  }

  async claimReadyEvents(options: ClaimEventsOptions): Promise<WebhookEventRecord[]> {
    const now = options.now ?? new Date()
    const lockTtl = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
    const lockExpiry = new Date(now.getTime() - lockTtl)

    // A row is reclaimable when it is unlocked or its lock has gone stale.
    const lockGuard = { OR: [{ lockedAt: null }, { lockedAt: { lt: lockExpiry } }] }
    // Ready = pending, or failed and due for retry. Exhausted rows have
    // nextRetryAt=null (set by the worker), so they never satisfy `lte: now`.
    const readyWhere = {
      AND: [
        { OR: [{ status: 'pending' }, { status: 'failed', nextRetryAt: { lte: now } }] },
        lockGuard,
      ],
    }

    // Step 1 — candidate ids (NO locking authority; just a cheap read).
    const candidates = await this.client.webhookEvent.findMany({
      where: readyWhere,
      orderBy: { createdAt: 'asc' },
      take: options.batchSize,
    })
    if (candidates.length === 0) return []
    const ids = candidates.map((c) => c.id)

    // Step 2 — THE source of truth. The lock guard is re-checked inside the
    // atomic UPDATE, so two workers racing the same candidates each win a
    // DISJOINT subset — never the same row twice.
    await this.client.webhookEvent.updateMany({
      where: { id: { in: ids }, ...lockGuard },
      data: { lockedAt: now, lockedBy: options.workerId },
    })

    // Step 3 — read back exactly the rows THIS worker just locked.
    const claimed = await this.client.webhookEvent.findMany({
      where: { lockedBy: options.workerId, lockedAt: now },
    })
    return claimed.map(toEventRecord)
  }

  async updateAfterAttempt(input: UpdateAfterAttemptInput): Promise<void> {
    try {
      await this.client.webhookEvent.update({
        where: { id: input.id },
        data: {
          status: input.status,
          attempts: input.attempts,
          nextRetryAt: input.nextRetryAt,
          lastError: input.lastError,
          deliveredAt: input.deliveredAt,
          lockedAt: null,
          lockedBy: null,
        },
      })
    } catch {
      /* row vanished (endpoint cascade-deleted) — nothing to write back */
    }
  }

  async listEventsForEndpoint(endpointId: string, limit = 100): Promise<WebhookEventRecord[]> {
    const rows = await this.client.webhookEvent.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.map(toEventRecord)
  }

  async getEvent(id: string): Promise<WebhookEventRecord | null> {
    const row = await this.client.webhookEvent.findUnique({ where: { id } })
    return row ? toEventRecord(row) : null
  }
}
