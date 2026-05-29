import { describe, it, expect, vi } from 'vitest'
import { createRuntime } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'
import type { HandlerFn } from '../../src/hooks/types.js'

// ── Shared spec helpers ───────────────────────────────────────────────────────

function makeSpec(hooks?: ZeroAPISpec['resources'][0]['hooks'], customEndpoints?: ZeroAPISpec['resources'][0]['customEndpoints']): ZeroAPISpec {
  return {
    version: '1.0.0', name: 'hook-test',
    resources: [{
      name: 'Item',
      fields: { label: { type: 'string', required: true } },
      hooks,
      customEndpoints,
    }],
  }
}

const opts = {
  enableLogging: false, enableDocs: false,
  enableHelmet: false, enableCors: false, enableSanitize: false,
}

// ── beforeCreate ─────────────────────────────────────────────────────────────

describe('beforeCreate hook', () => {
  it('cancels creation when it throws — store remains empty', async () => {
    const spec = makeSpec({ beforeCreate: 'block' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { block: () => { throw new Error('Not allowed') } },
    })

    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Forbidden' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; details: string }
    expect(body.error).toBe('Hook rejected request')
    expect(body.details).toContain('Not allowed')

    // Store must be empty — item was NOT created
    const list = await app.request('/items')
    const { count } = await list.json() as { count: number }
    expect(count).toBe(0)
  })

  it('receives the request input with correct fields', async () => {
    let capturedInput: Record<string, unknown> = {}
    const spec = makeSpec({ beforeCreate: 'capture' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { capture: ({ input }) => { capturedInput = { ...input } } },
    })

    await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Hello' }),
    })

    expect(capturedInput['label']).toBe('Hello')
  })

  it('mutations to input are persisted in the stored record', async () => {
    const spec = makeSpec({ beforeCreate: 'mutate' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: {
        mutate: ({ input }) => {
          input['label'] = 'MUTATED'
        },
      },
    })

    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Original' }),
    })
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { label: string; id: string } }

    // Verify the mutated value is what's stored
    const readRes = await app.request(`/items/${data.id}`)
    const { data: stored } = await readRes.json() as { data: { label: string } }
    expect(stored.label).toBe('MUTATED')
  })

  it('unknown hook ID is silently skipped — creation succeeds', async () => {
    const spec = makeSpec({ beforeCreate: 'nonexistent-handler' })
    const { app } = createRuntime(spec, { ...opts, handlers: {} })

    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'OK' }),
    })
    expect(res.status).toBe(201)
  })
})

// ── afterCreate ───────────────────────────────────────────────────────────────

describe('afterCreate hook', () => {
  it('is called after creation — receives the created item including id', async () => {
    let afterId: string | undefined
    const spec = makeSpec({ afterCreate: 'capture' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { capture: ({ input }) => { afterId = input['id'] as string } },
    })

    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Post' }),
    })
    const { data } = await res.json() as { data: { id: string } }

    expect(afterId).toBe(data.id)
  })

  it('throwing in afterCreate does NOT roll back the created record', async () => {
    const spec = makeSpec({ afterCreate: 'fail' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { fail: () => { throw new Error('side-effect failure') } },
    })

    // Creation still succeeds despite the hook throwing
    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Persist' }),
    })
    expect(res.status).toBe(201)

    // Item is in the store
    const list = await app.request('/items')
    const { count } = await list.json() as { count: number }
    expect(count).toBe(1)
  })
})

// ── beforeUpdate ──────────────────────────────────────────────────────────────

describe('beforeUpdate hook', () => {
  it('cancels update when it throws — record unchanged', async () => {
    const spec = makeSpec({ beforeUpdate: 'block' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { block: () => { throw new Error('Update not allowed') } },
    })

    // Create record
    const createRes = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Original' }),
    })
    const { data } = await createRes.json() as { data: { id: string } }

    // Attempt update — should be blocked
    const updateRes = await app.request(`/items/${data.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Updated' }),
    })
    expect(updateRes.status).toBe(400)
    expect((await updateRes.json() as { error: string }).error).toBe('Hook rejected request')

    // Record must still have original value
    const readRes = await app.request(`/items/${data.id}`)
    const { data: stored } = await readRes.json() as { data: { label: string } }
    expect(stored.label).toBe('Original')
  })

  it('mutations to update input are applied to the stored record', async () => {
    const spec = makeSpec({ beforeUpdate: 'uppercase' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: {
        uppercase: ({ input }) => {
          if (typeof input['label'] === 'string') input['label'] = input['label'].toUpperCase()
        },
      },
    })

    const createRes = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'hello' }),
    })
    const { data } = await createRes.json() as { data: { id: string } }

    await app.request(`/items/${data.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'world' }),
    })

    const readRes = await app.request(`/items/${data.id}`)
    const { data: stored } = await readRes.json() as { data: { label: string } }
    expect(stored.label).toBe('WORLD')
  })
})

// ── afterUpdate ───────────────────────────────────────────────────────────────

describe('afterUpdate hook', () => {
  it('is called after update — receives the updated item', async () => {
    let afterLabel: string | undefined
    const spec = makeSpec({ afterUpdate: 'capture' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { capture: ({ input }) => { afterLabel = input['label'] as string } },
    })

    const createRes = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'before' }),
    })
    const { data } = await createRes.json() as { data: { id: string } }

    await app.request(`/items/${data.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'after' }),
    })

    expect(afterLabel).toBe('after')
  })
})

// ── beforeDelete ──────────────────────────────────────────────────────────────

describe('beforeDelete hook', () => {
  it('cancels deletion when it throws — record still in store', async () => {
    const spec = makeSpec({ beforeDelete: 'block' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { block: () => { throw new Error('Cannot delete') } },
    })

    const createRes = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Protect Me' }),
    })
    const { data } = await createRes.json() as { data: { id: string } }

    const delRes = await app.request(`/items/${data.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(400)

    // Record must still exist
    const readRes = await app.request(`/items/${data.id}`)
    expect(readRes.status).toBe(200)
    const { data: stored } = await readRes.json() as { data: { label: string } }
    expect(stored.label).toBe('Protect Me')
  })

  it('receives the id of the record being deleted', async () => {
    let deletedId: string | undefined
    const spec = makeSpec({ beforeDelete: 'capture' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { capture: ({ input }) => { deletedId = input['id'] as string } },
    })

    const createRes = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Gone' }),
    })
    const { data } = await createRes.json() as { data: { id: string } }

    await app.request(`/items/${data.id}`, { method: 'DELETE' })
    expect(deletedId).toBe(data.id)
  })
})

// ── afterDelete ───────────────────────────────────────────────────────────────

describe('afterDelete hook', () => {
  it('is called after deletion completes', async () => {
    const afterDeleteCalled = vi.fn()
    const spec = makeSpec({ afterDelete: 'notify' })
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { notify: afterDeleteCalled },
    })

    const createRes = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Delete me' }),
    })
    const { data } = await createRes.json() as { data: { id: string } }

    const delRes = await app.request(`/items/${data.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    expect(afterDeleteCalled).toHaveBeenCalledTimes(1)
  })
})

// ── Custom endpoints ──────────────────────────────────────────────────────────

describe('Custom endpoints', () => {
  it('GET custom endpoint calls handler and returns its response', async () => {
    const spec = makeSpec(undefined, [
      { method: 'GET', path: '/stats', handler: 'getStats' },
    ])
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: {
        getStats: ({ ctx }) => ctx.json({ data: { total: 42 } }),
      },
    })

    const res = await app.request('/items/stats')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { total: number } }
    expect(body.data.total).toBe(42)
  })

  it('POST custom endpoint receives request body in input', async () => {
    let receivedInput: Record<string, unknown> = {}
    const spec = makeSpec(undefined, [
      { method: 'POST', path: '/bulk-create', handler: 'bulkCreate' },
    ])
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: {
        bulkCreate: ({ input, ctx }) => {
          receivedInput = { ...input }
          return ctx.json({ data: { created: true } }, 201)
        },
      },
    })

    await app.request('/items/bulk-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['a', 'b', 'c'] }),
    })

    expect(receivedInput['items']).toEqual(['a', 'b', 'c'])
  })

  it('custom endpoint with unknown handler returns 501', async () => {
    const spec = makeSpec(undefined, [
      { method: 'GET', path: '/missing', handler: 'notRegistered' },
    ])
    const { app } = createRuntime(spec, { ...opts, handlers: {} })

    const res = await app.request('/items/missing')
    expect(res.status).toBe(501)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('notRegistered')
  })

  it('handler that throws returns 400 with the error message', async () => {
    const spec = makeSpec(undefined, [
      { method: 'POST', path: '/fail', handler: 'boom' },
    ])
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: { boom: () => { throw new Error('Exploded') } },
    })

    const res = await app.request('/items/fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('Exploded')
  })

  it('multiple custom endpoints on the same resource all work', async () => {
    const spec = makeSpec(undefined, [
      { method: 'GET',  path: '/ping',  handler: 'ping' },
      { method: 'POST', path: '/pong',  handler: 'pong' },
    ])
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: {
        ping: ({ ctx }) => ctx.json({ data: 'pong' }),
        pong: ({ ctx }) => ctx.json({ data: 'ping' }),
      },
    })

    const pingRes = await app.request('/items/ping')
    const pongRes = await app.request('/items/pong', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect((await pingRes.json() as { data: string }).data).toBe('pong')
    expect((await pongRes.json() as { data: string }).data).toBe('ping')
  })
})

// ── HandlerFn typing ──────────────────────────────────────────────────────────

describe('HandlerFn type contract', () => {
  it('handler can access the DataStore', async () => {
    let storeSize: number | undefined
    const spec: ZeroAPISpec = {
      version: '1.0.0', name: 'store-test',
      resources: [{
        name: 'Widget',
        fields: { name: { type: 'string', required: true } },
        customEndpoints: [{ method: 'GET', path: '/count', handler: 'countAll' }],
      }],
    }
    const { app } = createRuntime(spec, {
      ...opts,
      handlers: {
        countAll: ({ store, ctx }) => {
          const widgetStore = store.get('widget')
          storeSize = widgetStore?.size ?? 0
          return ctx.json({ data: { count: storeSize } })
        },
      },
    })

    // Create 2 widgets first
    await app.request('/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A' }),
    })
    await app.request('/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B' }),
    })

    await app.request('/widgets/count')
    expect(storeSize).toBe(2)
  })
})
