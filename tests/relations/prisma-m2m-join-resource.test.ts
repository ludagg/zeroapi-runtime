import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRuntime, parseSpec } from '../../src/index.js'
import { extractM2MFilters } from '../../src/relations/prisma-include.js'
import { FakePrismaClient, type FakeRelationMap } from '../store/fake-prisma.js'

// Order N—N Product via an EXPLICIT association entity (OrderItem) whose FK to
// Product uses a CUSTOM field name (`prodRef`, not the conventional `productId`).
const spec = parseSpec({
  version: '1.0.0',
  name: 'shop',
  resources: [
    {
      name: 'Order',
      fields: { ref: { type: 'string', required: true } },
      relations: [{ type: 'manyToMany', resource: 'Product', through: 'OrderItem' }],
    },
    { name: 'Product', fields: { name: { type: 'string', required: true } } },
    {
      name: 'OrderItem',
      fields: { qty: { type: 'integer', required: true } },
      relations: [
        { type: 'manyToOne', resource: 'Order', field: 'orderId', required: true },
        { type: 'manyToOne', resource: 'Product', field: 'prodRef', required: true },
      ],
    },
  ],
})

const orderResource = spec.resources.find((r) => r.name === 'Order')!

describe('Fix 2 — M2M filtering on an association entity (custom FK)', () => {
  it('derives the target FK from the join resource (prodRef, not productId)', () => {
    const { where } = extractM2MFilters(orderResource, { product: { eq: 'P1' } } as never, spec)
    expect(where).toEqual({ orderItems: { some: { prodRef: 'P1' } } })
  })

  it('still uses the synthetic convention when there is no join resource', () => {
    const synthetic = parseSpec({
      version: '1.0.0', name: 's',
      resources: [
        { name: 'Post', fields: { t: { type: 'string', required: true } },
          relations: [{ type: 'manyToMany', resource: 'Tag', through: 'PostTags' }] },
        { name: 'Tag', fields: { label: { type: 'string', required: true } } },
      ],
    })
    const post = synthetic.resources.find((r) => r.name === 'Post')!
    const { where } = extractM2MFilters(post, { tag: { eq: 'T1' } } as never, synthetic)
    expect(where).toEqual({ postTags: { some: { tagId: 'T1' } } })
  })

  it('filters orders by product through the association entity (real query)', async () => {
    const db = new FakePrismaClient(['order', 'product', 'orderItem'], {
      order: [{ field: 'orderItems', target: 'orderItem', kind: 'toMany', fk: 'orderId' }],
    } satisfies FakeRelationMap)
    const { app } = createRuntime(spec, { enableLogging: false, prisma: db as unknown as never })
    const req = (path: string, b: unknown) =>
      app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })

    const pA = { id: randomUUID(), name: 'A' }
    const pB = { id: randomUUID(), name: 'B' }
    db.delegate('product').rows.set(pA.id, pA)
    db.delegate('product').rows.set(pB.id, pB)
    const o1 = await (await req('/orders', { ref: 'has-A' })).json() as { data: { id: string } }
    const o2 = await (await req('/orders', { ref: 'has-B' })).json() as { data: { id: string } }
    // Note the CUSTOM fk column `prodRef` on the join rows.
    db.delegate('orderItem').rows.set('i1', { id: 'i1', orderId: o1.data.id, prodRef: pA.id, qty: 1 })
    db.delegate('orderItem').rows.set('i2', { id: 'i2', orderId: o2.data.id, prodRef: pB.id, qty: 1 })

    const res = await app.request(`/orders?product=${pA.id}`)
    const body = await res.json() as { data: Array<{ ref: string }> }
    expect(body.data.map((o) => o.ref)).toEqual(['has-A'])
  })
})
