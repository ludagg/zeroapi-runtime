import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRuntime, parseSpec } from '../../src/index.js'
import { FakePrismaClient } from '../store/fake-prisma.js'

const spec = parseSpec({
  version: '1.0.0',
  name: 'shop',
  resources: [
    {
      name: 'Product',
      fields: {
        name: { type: 'string', required: true },
        stock: { type: 'integer', required: true, min: 0 },
      },
    },
    {
      name: 'Purchase',
      fields: {
        productId: { type: 'uuid', required: true },
        quantity: { type: 'integer', required: true, min: 1 },
      },
      relations: [{ type: 'manyToOne', resource: 'Product', field: 'productId', required: true }],
      // POST a purchase → atomically decrement the product's stock.
      transactions: [
        {
          trigger: 'POST',
          operations: [
            { action: 'decrement', resource: 'Product', idFrom: 'productId', field: 'stock', amountFrom: 'quantity' },
          ],
        },
      ],
    },
  ],
})

function makeRuntime(db: FakePrismaClient) {
  return createRuntime(spec, { enableLogging: false, prisma: db as unknown as never })
}

function seedProduct(db: FakePrismaClient, stock: number): string {
  const id = randomUUID()
  db.delegate('product').rows.set(id, { id, name: 'widget', stock })
  return id
}

describe('Prisma-mode transactions ($transaction)', () => {
  it('decrements stock atomically on a successful purchase', async () => {
    const db = new FakePrismaClient(['product', 'purchase'])
    const productId = seedProduct(db, 5)
    const { app } = makeRuntime(db)

    const res = await app.request('/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, quantity: 2 }),
    })
    expect(res.status).toBe(201)
    expect(db.delegate('product').rows.get(productId)?.['stock']).toBe(3)
    // The purchase row was persisted to the DB.
    expect(db.delegate('purchase').rows.size).toBe(1)
  })

  it('returns 409 and does NOT decrement when stock is insufficient', async () => {
    const db = new FakePrismaClient(['product', 'purchase'])
    const productId = seedProduct(db, 1)
    const { app } = makeRuntime(db)

    const res = await app.request('/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, quantity: 5 }),
    })
    expect(res.status).toBe(409)
    // Rolled back — stock untouched, no purchase persisted.
    expect(db.delegate('product').rows.get(productId)?.['stock']).toBe(1)
    expect(db.delegate('purchase').rows.size).toBe(0)
  })

  it('10 concurrent purchases on stock=1 → exactly 1×201 and 9×409', async () => {
    const db = new FakePrismaClient(['product', 'purchase'])
    const productId = seedProduct(db, 1)
    const { app } = makeRuntime(db)

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.request('/purchases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId, quantity: 1 }),
        }),
      ),
    )

    const statuses = responses.map((r) => r.status)
    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(statuses.filter((s) => s === 409)).toHaveLength(9)
    // Stock never goes negative; exactly one purchase recorded.
    expect(db.delegate('product').rows.get(productId)?.['stock']).toBe(0)
    expect(db.delegate('purchase').rows.size).toBe(1)
  })
})
