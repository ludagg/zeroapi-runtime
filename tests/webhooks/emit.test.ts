import { describe, it, expect } from 'vitest'
import { MemoryWebhookStore } from '../../src/webhooks/store.js'
import { emitWebhook, buildResourceEventType } from '../../src/webhooks/emit.js'

describe('emitWebhook', () => {
  it('creates one event per subscribed endpoint', async () => {
    const store = new MemoryWebhookStore()
    const a = await store.createEndpoint({ url: 'https://a.test', events: ['order.created'], secret: 's' })
    const b = await store.createEndpoint({ url: 'https://b.test', events: ['order.created', 'user.created'], secret: 's' })
    await store.createEndpoint({ url: 'https://c.test', events: ['user.created'], secret: 's' }) // not subscribed

    const created = await emitWebhook(store, 'order.created', { id: 'o1' })
    expect(created).toHaveLength(2)
    const endpointIds = created.map((e) => e.endpointId).sort()
    expect(endpointIds).toEqual([a.id, b.id].sort())
    expect(created[0]?.payload).toEqual({ id: 'o1' })
    expect(created[0]?.status).toBe('pending')
  })

  it('returns [] when no endpoint subscribes', async () => {
    const store = new MemoryWebhookStore()
    await store.createEndpoint({ url: 'https://x.test', events: ['other'], secret: 's' })
    const created = await emitWebhook(store, 'order.created', {})
    expect(created).toEqual([])
  })

  it('honours custom maxAttempts', async () => {
    const store = new MemoryWebhookStore()
    await store.createEndpoint({ url: 'https://a.test', events: ['order.created'], secret: 's' })
    const created = await emitWebhook(store, 'order.created', {}, { maxAttempts: 3 })
    expect(created[0]?.maxAttempts).toBe(3)
  })

  it('matches wildcard subscribers', async () => {
    const store = new MemoryWebhookStore()
    await store.createEndpoint({ url: 'https://w.test', events: ['*'], secret: 's' })
    const created = await emitWebhook(store, 'anything.happened', {})
    expect(created).toHaveLength(1)
  })
})

describe('buildResourceEventType', () => {
  it('returns lowercased {resource}.{action}', () => {
    expect(buildResourceEventType('Order', 'created')).toBe('order.created')
    expect(buildResourceEventType('user', 'deleted')).toBe('user.deleted')
  })
})
