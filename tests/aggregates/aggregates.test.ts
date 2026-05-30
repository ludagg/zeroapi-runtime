import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRuntime, parseSpec, ParseError } from '../../src/index.js'
import { FakePrismaClient } from '../store/fake-prisma.js'

// User 1—N Order, User 1—N Comment; aggregates declared on User.
const spec = parseSpec({
  version: '1.0.0',
  name: 'shop',
  resources: [
    {
      name: 'User',
      fields: { name: { type: 'string', required: true } },
      relations: [
        { type: 'oneToMany', resource: 'Order' },
        { type: 'oneToMany', resource: 'Comment' },
      ],
      aggregates: [
        { name: 'orderCount', op: 'count', relation: 'orders' },
        { name: 'totalSpent', op: 'sum', relation: 'orders', field: 'total' },
        { name: 'avgOrder', op: 'avg', relation: 'orders', field: 'total' },
        { name: 'minOrder', op: 'min', relation: 'orders', field: 'total' },
        { name: 'maxOrder', op: 'max', relation: 'orders', field: 'total' },
        { name: 'commentCount', op: 'count', relation: 'comments' },
      ],
    },
    {
      name: 'Order',
      fields: { total: { type: 'integer', required: true } },
      relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: true }],
    },
    {
      name: 'Comment',
      fields: { text: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: true }],
    },
  ],
})

// ── parser validation ─────────────────────────────────────────────────────────
describe('aggregate parser validation', () => {
  const base = (agg: Record<string, unknown>) => ({
    version: '1.0.0', name: 's',
    resources: [
      { name: 'User', fields: { name: { type: 'string', required: true } },
        relations: [{ type: 'oneToMany', resource: 'Order' }, { type: 'manyToOne', resource: 'Org', field: 'orgId' }],
        aggregates: [agg] },
      { name: 'Order', fields: { total: { type: 'integer', required: true }, label: { type: 'string', required: true } } },
      { name: 'Org', fields: { name: { type: 'string', required: true } } },
    ],
  })
  it('rejects an unknown op (zod)', () => {
    expect(() => parseSpec(base({ name: 'x', op: 'median', relation: 'orders' }))).toThrow(ParseError)
  })
  it('rejects a relation that is not oneToMany', () => {
    expect(() => parseSpec(base({ name: 'x', op: 'count', relation: 'Org' }))).toThrow(/not a oneToMany/i)
  })
  it('rejects count with a field', () => {
    expect(() => parseSpec(base({ name: 'x', op: 'count', relation: 'orders', field: 'total' }))).toThrow(/must not specify "field"/i)
  })
  it('rejects sum without a field', () => {
    expect(() => parseSpec(base({ name: 'x', op: 'sum', relation: 'orders' }))).toThrow(/requires a "field"/i)
  })
  it('rejects sum/avg on a non-numeric field', () => {
    expect(() => parseSpec(base({ name: 'x', op: 'sum', relation: 'orders', field: 'label' }))).toThrow(/numeric field/i)
  })
  it('accepts a valid aggregate', () => {
    expect(() => parseSpec(base({ name: 'x', op: 'sum', relation: 'orders', field: 'total' }))).not.toThrow()
  })
})

// ── runtime (both modes) ──────────────────────────────────────────────────────
for (const mode of ['memory', 'prisma'] as const) {
  describe(`aggregates runtime (${mode} mode)`, () => {
    function setup() {
      const db = mode === 'prisma' ? new FakePrismaClient(['user', 'order', 'comment']) : undefined
      const app = createRuntime(spec, { enableLogging: false, ...(db ? { prisma: db as unknown as never } : {}) }).app
      return { app, db }
    }
    const post = (app: ReturnType<typeof setup>['app'], path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = (r: Response) => r.json() as any

    async function seedUserWithOrders(app: ReturnType<typeof setup>['app'], name: string, totals: number[], comments = 0) {
      const u = await j(await post(app, '/users', { name }))
      for (const total of totals) await post(app, '/orders', { total, userId: u.data.id })
      for (let i = 0; i < comments; i++) await post(app, '/comments', { text: `c${i}`, userId: u.data.id })
      return u.data.id
    }

    it('computes count / sum / avg / min / max correctly', async () => {
      const { app } = setup()
      const id = await seedUserWithOrders(app, 'Ada', [10, 20, 30], 2)
      const res = await app.request(`/users/${id}?include=orderCount,totalSpent,avgOrder,minOrder,maxOrder,commentCount`)
      const body = await j(res)
      expect(body.data.orderCount).toBe(3)
      expect(body.data.totalSpent).toBe(60)
      expect(body.data.avgOrder).toBe(20)
      expect(body.data.minOrder).toBe(10)
      expect(body.data.maxOrder).toBe(30)
      expect(body.data.commentCount).toBe(2)
    })

    it('a user with no children → count/sum 0, avg/min/max null', async () => {
      const { app } = setup()
      const id = await seedUserWithOrders(app, 'Empty', [])
      const body = await j(await app.request(`/users/${id}?include=orderCount,totalSpent,avgOrder,minOrder`))
      expect(body.data.orderCount).toBe(0)
      expect(body.data.totalSpent).toBe(0)
      expect(body.data.avgOrder).toBeNull()
      expect(body.data.minOrder).toBeNull()
    })

    it('aggregates are opt-in — absent unless requested', async () => {
      const { app } = setup()
      const id = await seedUserWithOrders(app, 'Bob', [5])
      const body = await j(await app.request(`/users/${id}`))
      expect(body.data.orderCount).toBeUndefined()
      expect(body.data.totalSpent).toBeUndefined()
    })

    it('list endpoint computes aggregates per row', async () => {
      const { app } = setup()
      await seedUserWithOrders(app, 'A', [10, 10])
      await seedUserWithOrders(app, 'B', [100])
      const body = await j(await app.request('/users?include=orderCount,totalSpent&sort=name'))
      const byName = Object.fromEntries(body.data.map((u: any) => [u.name, u]))
      expect(byName['A'].orderCount).toBe(2)
      expect(byName['A'].totalSpent).toBe(20)
      expect(byName['B'].orderCount).toBe(1)
      expect(byName['B'].totalSpent).toBe(100)
    })
  })
}

// ── anti-N+1 (Prisma) ─────────────────────────────────────────────────────────
describe('aggregates are batched (no N+1)', () => {
  it('one groupBy per relation regardless of the number of rows', async () => {
    const db = new FakePrismaClient(['user', 'order', 'comment'])
    const app = createRuntime(spec, { enableLogging: false, prisma: db as unknown as never }).app
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    // 8 users, each with orders + comments.
    for (let i = 0; i < 8; i++) {
      const u = await (await post('/users', { name: `u${i}` })).json() as any
      await post('/orders', { total: i * 10, userId: u.data.id })
      await post('/comments', { text: 'c', userId: u.data.id })
    }

    db.groupByCalls = 0
    const body = await (await app.request('/users?include=orderCount,totalSpent,avgOrder,commentCount')).json() as any
    expect(body.data).toHaveLength(8)
    // 5 aggregates across 2 relations (orders, comments) → exactly 2 groupBy calls,
    // NOT one per user (which would be 8 or 16).
    expect(db.groupByCalls).toBe(2)
  })
})
