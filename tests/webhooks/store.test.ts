import { describe, it, expect } from 'vitest'
import { MemoryWebhookStore } from '../../src/webhooks/store.js'

async function makeEndpoint(store: MemoryWebhookStore, events: string[] = ['order.created']) {
  return store.createEndpoint({
    url: 'https://example.com/hook',
    events,
    secret: 'whsec_test',
  })
}

describe('MemoryWebhookStore — endpoints', () => {
  it('creates and lists endpoints', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    expect(ep.id).toBeDefined()
    expect(ep.events).toBe('order.created')
    expect(ep.active).toBe(true)

    const list = await store.listEndpoints()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe(ep.id)
  })

  it('deletes endpoints', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    expect(await store.deleteEndpoint(ep.id)).toBe(true)
    expect(await store.deleteEndpoint('missing')).toBe(false)
    expect(await store.listEndpoints()).toHaveLength(0)
  })

  it('findActiveEndpointsForEvent matches subscribers', async () => {
    const store = new MemoryWebhookStore()
    await makeEndpoint(store, ['order.created'])
    await makeEndpoint(store, ['user.created'])
    await makeEndpoint(store, ['*'])
    const matches = await store.findActiveEndpointsForEvent('order.created')
    expect(matches).toHaveLength(2)   // first + wildcard
  })

  it('findActiveEndpointsForEvent skips inactive endpoints', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store, ['order.created'])
    // Reach into the record to toggle active state (no public mutator yet).
    const internal = (store as unknown as { endpoints: Map<string, { active: boolean }> }).endpoints
    internal.get(ep.id)!.active = false
    expect(await store.findActiveEndpointsForEvent('order.created')).toHaveLength(0)
  })
})

describe('MemoryWebhookStore — events', () => {
  it('creates a pending event with default maxAttempts=5', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    const ev = await store.createEvent({ endpointId: ep.id, eventType: 'order.created', payload: { id: 1 } })
    expect(ev.status).toBe('pending')
    expect(ev.attempts).toBe(0)
    expect(ev.maxAttempts).toBe(5)
  })

  it('claimReadyEvents locks pending events and respects batchSize', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    for (let i = 0; i < 5; i++) {
      await store.createEvent({ endpointId: ep.id, eventType: 'order.created', payload: { i } })
    }
    const claimed = await store.claimReadyEvents({ workerId: 'w1', batchSize: 3 })
    expect(claimed).toHaveLength(3)
    // Reclaim would only get the remaining 2 — the 3 first are now locked.
    const more = await store.claimReadyEvents({ workerId: 'w2', batchSize: 10 })
    expect(more).toHaveLength(2)
  })

  it('claimReadyEvents skips events whose lock is still fresh', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    await store.createEvent({ endpointId: ep.id, eventType: 'order.created', payload: 1 })
    const first = await store.claimReadyEvents({ workerId: 'w1', batchSize: 5 })
    expect(first).toHaveLength(1)
    const again = await store.claimReadyEvents({ workerId: 'w2', batchSize: 5 })
    expect(again).toHaveLength(0)
  })

  it('claimReadyEvents reclaims events with expired locks', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    await store.createEvent({ endpointId: ep.id, eventType: 'order.created', payload: 1 })

    const t0 = new Date('2030-01-01T00:00:00Z')
    const claimed = await store.claimReadyEvents({ workerId: 'w1', batchSize: 5, now: t0, lockTtlMs: 60_000 })
    expect(claimed).toHaveLength(1)

    // Same instant → still locked.
    expect(await store.claimReadyEvents({ workerId: 'w2', batchSize: 5, now: t0, lockTtlMs: 60_000 })).toHaveLength(0)
    // 2 min later → lock is stale → reclaim.
    const later = new Date(t0.getTime() + 2 * 60_000)
    const reclaimed = await store.claimReadyEvents({ workerId: 'w2', batchSize: 5, now: later, lockTtlMs: 60_000 })
    expect(reclaimed).toHaveLength(1)
  })

  it('claimReadyEvents respects nextRetryAt for failed events', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    const ev = await store.createEvent({ endpointId: ep.id, eventType: 'order.created', payload: 1 })

    const inFuture = new Date(Date.now() + 60_000)
    await store.updateAfterAttempt({
      id: ev.id, status: 'failed', attempts: 1,
      nextRetryAt: inFuture, lastError: 'boom', deliveredAt: null,
    })
    // Now → not yet ready.
    expect(await store.claimReadyEvents({ workerId: 'w', batchSize: 5 })).toHaveLength(0)
    // After nextRetryAt → ready again.
    const claimed = await store.claimReadyEvents({
      workerId: 'w', batchSize: 5,
      now: new Date(inFuture.getTime() + 1000),
    })
    expect(claimed).toHaveLength(1)
  })

  it('claimReadyEvents skips events that exhausted maxAttempts', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    const ev = await store.createEvent({
      endpointId: ep.id, eventType: 'order.created', payload: 1, maxAttempts: 2,
    })
    await store.updateAfterAttempt({
      id: ev.id, status: 'failed', attempts: 2,
      nextRetryAt: null, lastError: 'boom', deliveredAt: null,
    })
    expect(await store.claimReadyEvents({ workerId: 'w', batchSize: 5 })).toHaveLength(0)
  })

  it('listEventsForEndpoint returns events most-recent first', async () => {
    const store = new MemoryWebhookStore()
    const ep = await makeEndpoint(store)
    const a = await store.createEvent({ endpointId: ep.id, eventType: 'x', payload: 1 })
    await new Promise((r) => setTimeout(r, 5))
    const b = await store.createEvent({ endpointId: ep.id, eventType: 'x', payload: 2 })
    const list = await store.listEventsForEndpoint(ep.id)
    expect(list.map((e) => e.id)).toEqual([b.id, a.id])
  })
})
