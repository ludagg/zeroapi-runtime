import { describe, it, expect } from 'vitest'
import { MemoryWebhookStore } from '../../src/webhooks/store.js'
import { emitWebhook } from '../../src/webhooks/emit.js'
import { WebhookWorker, computeBackoffDelay } from '../../src/webhooks/worker.js'
import {
  SIGNATURE_HEADER, EVENT_TYPE_HEADER, EVENT_ID_HEADER, signPayload,
} from '../../src/webhooks/signature.js'

interface FetchCall {
  url: string
  method?: string
  headers: Record<string, string>
  body: string
}

function makeFetchMock(impl: (call: FetchCall) => { status: number } | Promise<{ status: number }> | Error) {
  const calls: FetchCall[] = []
  const fn: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers as Record<string, string>
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k] ?? ''
    }
    const call: FetchCall = {
      url: String(url),
      method: init?.method as string | undefined,
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(call)
    const result = await impl(call)
    if (result instanceof Error) throw result
    return new Response(null, { status: result.status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const FROZEN_NOW = new Date('2030-01-01T00:00:00Z')
function freeze(): () => Date { return () => FROZEN_NOW }

describe('computeBackoffDelay', () => {
  it('returns base*2^(attempts-1) capped at maxMs', () => {
    expect(computeBackoffDelay(1, 30_000, 1_800_000)).toBe(30_000)        // 30s
    expect(computeBackoffDelay(2, 30_000, 1_800_000)).toBe(60_000)        // 1m
    expect(computeBackoffDelay(3, 30_000, 1_800_000)).toBe(120_000)       // 2m
    expect(computeBackoffDelay(4, 30_000, 1_800_000)).toBe(240_000)       // 4m
    expect(computeBackoffDelay(5, 30_000, 1_800_000)).toBe(480_000)       // 8m
    expect(computeBackoffDelay(10, 30_000, 1_800_000)).toBe(1_800_000)    // capped
  })
})

describe('WebhookWorker.runOnce', () => {
  it('delivers a pending event and marks it delivered with the right signature', async () => {
    const store = new MemoryWebhookStore()
    const ep = await store.createEndpoint({
      url: 'https://hook.test/in', events: ['order.created'], secret: 'whsec_t',
    })
    const [event] = await emitWebhook(store, 'order.created', { id: 'o-1' })

    const { fn, calls } = makeFetchMock(() => ({ status: 200 }))
    const worker = new WebhookWorker(store, { fetchImpl: fn, now: freeze() })
    const processed = await worker.runOnce()
    expect(processed).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://hook.test/in')
    expect(calls[0]?.method).toBe('POST')

    const body = calls[0]?.body ?? ''
    expect(calls[0]?.headers[SIGNATURE_HEADER]).toBe(signPayload(ep.secret, body))
    expect(calls[0]?.headers[EVENT_TYPE_HEADER]).toBe('order.created')
    expect(calls[0]?.headers[EVENT_ID_HEADER]).toBe(event!.id)

    const updated = await store.getEvent(event!.id)
    expect(updated?.status).toBe('delivered')
    expect(updated?.attempts).toBe(1)
    expect(updated?.deliveredAt).toEqual(FROZEN_NOW)
    expect(updated?.lockedAt).toBeNull()
  })

  it('retries with exponential backoff on transient failure', async () => {
    const store = new MemoryWebhookStore()
    await store.createEndpoint({ url: 'https://hook.test/in', events: ['x'], secret: 's' })
    const [event] = await emitWebhook(store, 'x', { v: 1 })

    const { fn } = makeFetchMock(() => ({ status: 500 }))
    const worker = new WebhookWorker(store, {
      fetchImpl: fn, now: freeze(),
      backoffBaseMs: 1000, backoffMaxMs: 60_000,
    })

    await worker.runOnce()
    const after1 = await store.getEvent(event!.id)
    expect(after1?.status).toBe('failed')
    expect(after1?.attempts).toBe(1)
    expect(after1?.lastError).toBe('HTTP 500')
    expect(after1?.nextRetryAt).toEqual(new Date(FROZEN_NOW.getTime() + 1000))
  })

  it('marks the event as definitively failed after maxAttempts', async () => {
    const store = new MemoryWebhookStore()
    await store.createEndpoint({ url: 'https://hook.test/in', events: ['x'], secret: 's' })
    const [event] = await emitWebhook(store, 'x', { v: 1 }, { maxAttempts: 2 })

    const { fn } = makeFetchMock(() => ({ status: 500 }))
    // Tick 1 → fails, schedules retry.
    let now = new Date(FROZEN_NOW)
    const worker = new WebhookWorker(store, {
      fetchImpl: fn, now: () => now,
      backoffBaseMs: 100, backoffMaxMs: 60_000,
    })
    await worker.runOnce()
    let after = await store.getEvent(event!.id)
    expect(after?.attempts).toBe(1)
    expect(after?.nextRetryAt).not.toBeNull()

    // Advance past nextRetryAt and run again — attempts === maxAttempts → done.
    now = new Date(now.getTime() + 1000)
    await worker.runOnce()
    after = await store.getEvent(event!.id)
    expect(after?.attempts).toBe(2)
    expect(after?.status).toBe('failed')
    expect(after?.nextRetryAt).toBeNull()

    // A third tick should skip — no more retries.
    now = new Date(now.getTime() + 60_000)
    const processed = await worker.runOnce()
    expect(processed).toBe(0)
  })

  it('treats network errors the same as HTTP failures (retry)', async () => {
    const store = new MemoryWebhookStore()
    await store.createEndpoint({ url: 'https://hook.test/in', events: ['x'], secret: 's' })
    const [event] = await emitWebhook(store, 'x', { v: 1 })

    const { fn } = makeFetchMock(() => new Error('ECONNREFUSED'))
    const worker = new WebhookWorker(store, {
      fetchImpl: fn, now: freeze(),
      backoffBaseMs: 100, backoffMaxMs: 60_000,
    })
    await worker.runOnce()
    const after = await store.getEvent(event!.id)
    expect(after?.status).toBe('failed')
    expect(after?.attempts).toBe(1)
    expect(after?.lastError).toBe('ECONNREFUSED')
  })

  it('fails permanently when the endpoint was deleted between emit and delivery', async () => {
    const store = new MemoryWebhookStore()
    const ep = await store.createEndpoint({ url: 'https://x.test', events: ['x'], secret: 's' })
    const [event] = await emitWebhook(store, 'x', {})
    await store.deleteEndpoint(ep.id)

    const { fn, calls } = makeFetchMock(() => ({ status: 200 }))
    const worker = new WebhookWorker(store, { fetchImpl: fn, now: freeze() })
    await worker.runOnce()

    expect(calls).toHaveLength(0)
    const after = await store.getEvent(event!.id)
    expect(after?.status).toBe('failed')
    expect(after?.lastError).toBe('Endpoint no longer exists')
  })

  it('respects the lock — a second worker on the same tick claims nothing', async () => {
    const store = new MemoryWebhookStore()
    await store.createEndpoint({ url: 'https://x.test', events: ['x'], secret: 's' })
    await emitWebhook(store, 'x', {})

    const { fn: f1 } = makeFetchMock(() => ({ status: 200 }))
    const w1 = new WebhookWorker(store, { fetchImpl: f1, now: freeze(), workerId: 'w1' })

    // Manually claim with w1 (don't deliver yet) — emulate a slow tick.
    const claimed = await store.claimReadyEvents({ workerId: 'w1', batchSize: 10, now: FROZEN_NOW })
    expect(claimed).toHaveLength(1)

    // A second worker on the same instant cannot claim the locked row.
    const w2 = new WebhookWorker(store, { fetchImpl: f1, now: freeze(), workerId: 'w2' })
    const processed = await w2.runOnce()
    expect(processed).toBe(0)
  })
})

describe('WebhookWorker.start / stop', () => {
  it('start() is idempotent and stop() halts the timer', async () => {
    const store = new MemoryWebhookStore()
    const worker = new WebhookWorker(store, { intervalMs: 1_000_000, fetchImpl: globalThis.fetch })
    worker.start()
    worker.start()  // no-op
    worker.stop()
    // Calling stop twice is safe.
    worker.stop()
  })
})
