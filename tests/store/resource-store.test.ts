import { describe, it, expect } from 'vitest'
import { createRuntime, parseSpec } from '../../src/index.js'
import {
  MemoryResourceStore,
  MemoryResourceStoreProvider,
  PrismaResourceStore,
  PrismaResourceStoreProvider,
  prismaResourceDelegateName,
} from '../../src/index.js'
import type { DataStore } from '../../src/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// A fake Prisma client. Each model delegate keeps its rows in an internal Map —
// this Map IS "the database". Because the data lives on the client (not inside
// any runtime), pointing a brand-new runtime at the SAME client proves the data
// survives a "restart".
// ─────────────────────────────────────────────────────────────────────────────

class FakeDelegate {
  readonly rows = new Map<string, Record<string, unknown>>()

  async findMany(): Promise<Array<Record<string, unknown>>> {
    return Array.from(this.rows.values())
  }
  async findUnique(args: { where: { id: string } }): Promise<Record<string, unknown> | null> {
    return this.rows.get(args.where.id) ?? null
  }
  async create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const row = { ...args.data }
    this.rows.set(row['id'] as string, row)
    return row
  }
  async update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const existing = this.rows.get(args.where.id)
    if (!existing) throw new Error('P2025: record not found')
    const updated = { ...existing, ...args.data, id: args.where.id }
    this.rows.set(args.where.id, updated)
    return updated
  }
  async delete(args: { where: { id: string } }): Promise<Record<string, unknown>> {
    const existing = this.rows.get(args.where.id)
    if (!existing) throw new Error('P2025: record not found')
    this.rows.delete(args.where.id)
    return existing
  }
}

class FakePrismaClient {
  readonly todo = new FakeDelegate()
  readonly orderItem = new FakeDelegate()
}

const spec = parseSpec({
  version: '1.0.0',
  name: 'persistence-test',
  resources: [
    {
      name: 'Todo',
      fields: {
        title: { type: 'string', required: true },
        done: { type: 'boolean', required: false, default: false },
      },
    },
    {
      // Composite name → guards the OrderItem → `orderItem` delegate mapping.
      name: 'OrderItem',
      fields: {
        label: { type: 'string', required: true },
        qty: { type: 'integer', required: true, min: 1 },
      },
    },
  ],
})

function makeRuntime(prisma?: FakePrismaClient) {
  return createRuntime(spec, {
    enableLogging: false,
    ...(prisma ? { prisma: prisma as unknown as never } : {}),
  })
}

type TestApp = ReturnType<typeof makeRuntime>['app']

async function postTodo(app: TestApp, title: string): Promise<Response> {
  return app.request('/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

// ─────────────────────────────────────────────────────────────────────────────

describe('prismaResourceDelegateName — model name mapping', () => {
  it('lower-cases only the first character', () => {
    expect(prismaResourceDelegateName('Product')).toBe('product')
    expect(prismaResourceDelegateName('Category')).toBe('category')
  })
  it('preserves casing of composite names (OrderItem → orderItem)', () => {
    expect(prismaResourceDelegateName('OrderItem')).toBe('orderItem')
    expect(prismaResourceDelegateName('UserProfile')).toBe('userProfile')
  })
})

describe('MemoryResourceStore — interface over a Map', () => {
  it('round-trips create/get/list/update/delete', async () => {
    const map = new Map<string, Record<string, unknown>>()
    const store = new MemoryResourceStore(map)

    await store.create('1', { id: '1', title: 'a' })
    expect(await store.get('1')).toEqual({ id: '1', title: 'a' })
    expect(await store.list()).toHaveLength(1)

    await store.update('1', { id: '1', title: 'b' })
    expect((await store.get('1'))?.['title']).toBe('b')

    expect(await store.delete('1')).toBe(true)
    expect(await store.get('1')).toBeUndefined()
    expect(await store.delete('1')).toBe(false)
  })

  it('MemoryResourceStoreProvider shares the underlying DataStore map', async () => {
    const data: DataStore = new Map()
    const provider = new MemoryResourceStoreProvider(data)
    const store = provider.for('Todo')
    await store.create('x', { id: 'x', title: 'shared' })
    // The same map is visible directly on the DataStore — proving relations /
    // transactions (which read the raw map) see writes made via the store.
    expect(data.get('todo')?.get('x')).toEqual({ id: 'x', title: 'shared' })
  })
})

describe('PrismaResourceStore — persists to the (fake) database', () => {
  it('create/get/list/update/delete hit the delegate', async () => {
    const client = new FakePrismaClient()
    const store = new PrismaResourceStore(client as never, 'todo')

    await store.create('1', { id: '1', title: 'a', done: false })
    expect(client.todo.rows.get('1')).toMatchObject({ id: '1', title: 'a' })
    expect(await store.get('1')).toMatchObject({ title: 'a' })
    expect(await store.list()).toHaveLength(1)

    await store.update('1', { id: '1', title: 'b' })
    expect(client.todo.rows.get('1')).toMatchObject({ title: 'b' })

    expect(await store.delete('1')).toBe(true)
    expect(client.todo.rows.has('1')).toBe(false)
    // Deleting a missing row mirrors Map.delete()'s "false", never throws.
    expect(await store.delete('1')).toBe(false)
  })

  it('provider falls back to memory for resources without a delegate', async () => {
    const client = new FakePrismaClient() // has todo + orderItem, NOT widget
    const memoryData: DataStore = new Map()
    const provider = new PrismaResourceStoreProvider(
      client as never,
      new MemoryResourceStoreProvider(memoryData),
    )
    const widget = provider.for('Widget')
    await widget.create('w1', { id: 'w1', name: 'gizmo' })
    // Landed in memory, not in any Prisma delegate.
    expect(memoryData.get('widget')?.get('w1')).toMatchObject({ name: 'gizmo' })
  })
})

describe('createRuntime — Prisma-backed resources persist across a restart', () => {
  it('POST writes to the DB and GET reads it back', async () => {
    const db = new FakePrismaClient()
    const { app } = makeRuntime(db)

    const res = await postTodo(app, 'buy milk')
    expect(res.status).toBe(201)
    const created = await res.json() as { data: { id: string; title: string } }
    expect(created.data.title).toBe('buy milk')

    // It physically landed in the fake DB.
    expect(db.todo.rows.get(created.data.id)).toMatchObject({ title: 'buy milk' })

    const list = await (await app.request('/todos')).json() as { data: unknown[]; count: number }
    expect(list.count).toBe(1)
  })

  it('data SURVIVES a runtime rebuild (simulated container restart)', async () => {
    const db = new FakePrismaClient()

    // ── boot #1: create a todo ──
    const rt1 = makeRuntime(db)
    const res = await postTodo(rt1.app, 'persist me')
    const id = (await res.json() as { data: { id: string } }).data.id

    // ── boot #2: brand-new runtime, SAME database ──
    const rt2 = makeRuntime(db)
    const readback = await rt2.app.request(`/todos/${id}`)
    expect(readback.status).toBe(200)
    const body = await readback.json() as { data: { id: string; title: string } }
    expect(body.data.id).toBe(id)
    expect(body.data.title).toBe('persist me')

    const list = await (await rt2.app.request('/todos')).json() as { count: number }
    expect(list.count).toBe(1)
  })

  it('PUT and DELETE persist across a rebuild', async () => {
    const db = new FakePrismaClient()

    const rt1 = makeRuntime(db)
    const id = (await (await postTodo(rt1.app, 'v1')).json() as { data: { id: string } }).data.id

    // Update on boot #1
    await rt1.app.request(`/todos/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'v2' }),
    })

    // Reboot → the update is still there
    const rt2 = makeRuntime(db)
    const afterUpdate = await (await rt2.app.request(`/todos/${id}`)).json() as { data: { title: string } }
    expect(afterUpdate.data.title).toBe('v2')

    // Delete on boot #2
    const del = await rt2.app.request(`/todos/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(db.todo.rows.has(id)).toBe(false)

    // Reboot again → still gone
    const rt3 = makeRuntime(db)
    expect((await rt3.app.request(`/todos/${id}`)).status).toBe(404)
  })

  it('composite-named resource (OrderItem) persists via the orderItem delegate', async () => {
    const db = new FakePrismaClient()
    const { app } = makeRuntime(db)

    const res = await app.request('/orderitems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'widget', qty: 3 }),
    })
    expect(res.status).toBe(201)
    const id = (await res.json() as { data: { id: string } }).data.id
    // Routed to the `orderItem` delegate, NOT a mis-mapped `orderitem`.
    expect(db.orderItem.rows.get(id)).toMatchObject({ label: 'widget', qty: 3 })
  })
})

describe('createRuntime — memory mode is the default and is volatile', () => {
  it('does NOT persist across a runtime rebuild (contrast with Prisma)', async () => {
    // boot #1 (no prisma → memory)
    const rt1 = makeRuntime()
    await postTodo(rt1.app, 'ephemeral')
    const list1 = await (await rt1.app.request('/todos')).json() as { count: number }
    expect(list1.count).toBe(1)

    // boot #2: a fresh runtime has its own empty Map — the todo is gone.
    const rt2 = makeRuntime()
    const list2 = await (await rt2.app.request('/todos')).json() as { count: number }
    expect(list2.count).toBe(0)
  })
})
