import { randomUUID } from 'crypto'
import type { WebhookStore, WebhookEventRecord, WebhookEndpointRecord } from './store.js'
import { signPayload, SIGNATURE_HEADER, EVENT_TYPE_HEADER, EVENT_ID_HEADER } from './signature.js'

export interface WebhookWorkerOptions {
  /** Polling interval. Defaults to 10 000 ms. */
  intervalMs?: number
  /** Max events processed per tick. Defaults to 25. */
  batchSize?: number
  /** Base for exponential backoff. Defaults to 30 000 ms (30s). */
  backoffBaseMs?: number
  /** Cap for exponential backoff. Defaults to 1 800 000 ms (30 min). */
  backoffMaxMs?: number
  /** Custom `fetch` implementation (tests inject a mock). */
  fetchImpl?: typeof fetch
  /** Override `Date.now` (tests). */
  now?: () => Date
  /** Lock TTL in ms — events whose lock is older are reclaimable. */
  lockTtlMs?: number
  /** Stable worker identifier — defaults to a random UUID. */
  workerId?: string
  /** Receives `[level, message]` lines; defaults to the runtime logger. */
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void
}

const DEFAULT_OPTIONS = {
  intervalMs: 10_000,
  batchSize: 25,
  backoffBaseMs: 30_000,
  backoffMaxMs: 30 * 60 * 1000,
  lockTtlMs: 2 * 60 * 1000,
} as const

type ResolvedOptions = Omit<Required<WebhookWorkerOptions>, 'fetchImpl' | 'log' | 'now'> & {
  fetchImpl: typeof fetch
  log: NonNullable<WebhookWorkerOptions['log']>
  now: () => Date
}

function resolveOptions(o: WebhookWorkerOptions = {}): ResolvedOptions {
  return {
    intervalMs:    o.intervalMs    ?? DEFAULT_OPTIONS.intervalMs,
    batchSize:     o.batchSize     ?? DEFAULT_OPTIONS.batchSize,
    backoffBaseMs: o.backoffBaseMs ?? DEFAULT_OPTIONS.backoffBaseMs,
    backoffMaxMs:  o.backoffMaxMs  ?? DEFAULT_OPTIONS.backoffMaxMs,
    lockTtlMs:     o.lockTtlMs     ?? DEFAULT_OPTIONS.lockTtlMs,
    workerId:      o.workerId      ?? randomUUID(),
    fetchImpl:     o.fetchImpl     ?? globalThis.fetch,
    now:           o.now           ?? (() => new Date()),
    log:           o.log           ?? ((_l, _m, _e) => { /* no-op */ }),
  }
}

/**
 * Exponential backoff with a configurable cap. Always returns a positive ms
 * value (caller stores it as `nextRetryAt = now + delay`).
 */
export function computeBackoffDelay(attempts: number, baseMs: number, maxMs: number): number {
  // attempts is the attempt count *after* this failure. So:
  //   attempt 1 failed → delay = base * 2^0 = base
  //   attempt 2 failed → delay = base * 2^1 = 2*base
  const exponent = Math.max(0, attempts - 1)
  const raw = baseMs * Math.pow(2, exponent)
  return Math.min(raw, maxMs)
}

/**
 * Background worker that drains pending / retryable `WebhookEvent` rows by
 * POSTing them to their endpoint URLs with an HMAC signature.
 *
 * Designed to run in-process — `start()` schedules a `setInterval`, `stop()`
 * clears it. Tests can call `runOnce()` directly and inject a mock `fetch`.
 */
export class WebhookWorker {
  readonly options: ResolvedOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly store: WebhookStore,
    options: WebhookWorkerOptions = {},
  ) {
    this.options = resolveOptions(options)
  }

  /** Starts the periodic tick. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      // Don't overlap ticks; if a previous tick is still draining, skip.
      if (this.inFlight) return
      this.inFlight = this.runOnce()
        .then(() => { /* discard count */ })
        .catch((err) => {
          this.options.log('error', 'webhook worker tick failed', { error: String(err) })
        })
        .finally(() => { this.inFlight = null })
    }, this.options.intervalMs)
    // Allow process exit even if the worker is running.
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref()
    }
  }

  /** Stops the periodic tick. Idempotent. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
  }

  /** Processes one batch of ready events. Useful for tests. */
  async runOnce(): Promise<number> {
    const opts = this.options
    const claimed = await this.store.claimReadyEvents({
      workerId: opts.workerId,
      batchSize: opts.batchSize,
      now: opts.now(),
      lockTtlMs: opts.lockTtlMs,
    })
    for (const event of claimed) {
      await this.deliver(event)
    }
    return claimed.length
  }

  /** Sends one event and writes the outcome back to the store. */
  private async deliver(event: WebhookEventRecord): Promise<void> {
    const opts = this.options
    const endpoint = await this.store.getEndpoint(event.endpointId)
    if (!endpoint) {
      // Endpoint was deleted between scheduling and delivery — fail definitively.
      await this.store.updateAfterAttempt({
        id: event.id,
        status: 'failed',
        attempts: event.maxAttempts,
        nextRetryAt: null,
        lastError: 'Endpoint no longer exists',
        deliveredAt: null,
      })
      return
    }

    const body = JSON.stringify({ id: event.id, type: event.eventType, payload: event.payload })
    const signature = signPayload(endpoint.secret, body)
    const attempts = event.attempts + 1

    let success = false
    let errorMessage: string | null = null

    try {
      const res = await opts.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signature,
          [EVENT_TYPE_HEADER]: event.eventType,
          [EVENT_ID_HEADER]: event.id,
        },
        body,
      })
      if (res.status >= 200 && res.status < 300) {
        success = true
      } else {
        errorMessage = `HTTP ${res.status}`
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    if (success) {
      await this.store.updateAfterAttempt({
        id: event.id,
        status: 'delivered',
        attempts,
        nextRetryAt: null,
        lastError: null,
        deliveredAt: opts.now(),
      })
      opts.log('info', `webhook delivered`, { eventId: event.id, eventType: event.eventType })
      return
    }

    const exhausted = attempts >= event.maxAttempts
    if (exhausted) {
      await this.store.updateAfterAttempt({
        id: event.id,
        status: 'failed',
        attempts,
        nextRetryAt: null,
        lastError: errorMessage,
        deliveredAt: null,
      })
      opts.log('warn', 'webhook gave up after max attempts', {
        eventId: event.id, attempts, error: errorMessage,
      })
      return
    }

    const delay = computeBackoffDelay(attempts, opts.backoffBaseMs, opts.backoffMaxMs)
    const nextRetryAt = new Date(opts.now().getTime() + delay)
    await this.store.updateAfterAttempt({
      id: event.id,
      status: 'failed',
      attempts,
      nextRetryAt,
      lastError: errorMessage,
      deliveredAt: null,
    })
    opts.log('warn', 'webhook delivery failed, retrying', {
      eventId: event.id, attempts, nextRetryAt: nextRetryAt.toISOString(), error: errorMessage,
    })
  }
}

/** Filtering / helper exports — re-used by the inbound handler too. */
export function endpointSubscribesTo(endpoint: WebhookEndpointRecord, eventType: string): boolean {
  const events = endpoint.events.split(',').map((s) => s.trim())
  return events.includes(eventType) || events.includes('*')
}
