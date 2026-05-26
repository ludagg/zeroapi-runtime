import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../src/index.js'
import { executeTransaction } from '../../src/transactions/executor.js'
import type { ZeroAPISpec, TxOperation } from '../../src/types/spec.js'
import type { DataStore } from '../../src/generators/routes.js'

// ── Unit tests for the executor ───────────────────────────────────────────────

function makeStore(initial?: Record<string, Record<string, unknown>[]>): DataStore {
  const store: DataStore = new Map()
  for (const [key, rows] of Object.entries(initial ?? {})) {
    const map = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      map.set(row['id'] as string, row)
    }
    store.set(key, map)
  }
  return store
}

describe('executeTransaction — unit', () => {
  it('create operation adds a record', async () => {
    const store = makeStore()
    const ops: TxOperation[] = [{ action: 'create', resource: 'item' }]
    const result = await executeTransaction(ops, { name: 'Widget' }, store)
    expect(result.success).toBe(true)
    expect(store.get('item')?.size).toBe(1)
  })

  it('decrement operation reduces a field', async () => {
    const store = makeStore({ product: [{ id: 'p1', stock: 10 }] })
    const ops: TxOperation[] = [
      { action: 'decrement', resource: 'product', idFrom: 'productId', field: 'stock', amount: 3 },
    ]
    const result = await executeTransaction(ops, { productId: 'p1' }, store)
    expect(result.success).toBe(true)
    expect(store.get('product')?.get('p1')?.['stock']).toBe(7)
  })

  it('decrement fails when stock would go below zero', async () => {
    const store = makeStore({ product: [{ id: 'p1', stock: 2 }] })
    const ops: TxOperation[] = [
      { action: 'decrement', resource: 'product', idFrom: 'productId', field: 'stock', amount: 5 },
    ]
    const result = await executeTransaction(ops, { productId: 'p1' }, store)
    expect(result.success).toBe(false)
    expect(result.error).toContain('below zero')
    // Rollback: stock unchanged
    expect(store.get('product')?.get('p1')?.['stock']).toBe(2)
  })

  it('increment operation increases a field', async () => {
    const store = makeStore({ counter: [{ id: 'c1', count: 0 }] })
    const ops: TxOperation[] = [
      { action: 'increment', resource: 'counter', idFrom: 'counterId', field: 'count', amount: 5 },
    ]
    const result = await executeTransaction(ops, { counterId: 'c1' }, store)
    expect(result.success).toBe(true)
    expect(store.get('counter')?.get('c1')?.['count']).toBe(5)
  })

  it('delete operation removes a record', async () => {
    const store = makeStore({ item: [{ id: 'i1', name: 'X' }] })
    const ops: TxOperation[] = [{ action: 'delete', resource: 'item', idFrom: 'id' }]
    const result = await executeTransaction(ops, { id: 'i1' }, store)
    expect(result.success).toBe(true)
    expect(store.get('item')?.has('i1')).toBe(false)
  })

  it('rolls back ALL operations on failure (multi-op)', async () => {
    const store = makeStore({ product: [{ id: 'p1', stock: 2 }] })
    const ops: TxOperation[] = [
      // op 1 succeeds
      { action: 'increment', resource: 'product', idFrom: 'productId', field: 'stock', amount: 1 },
      // op 2 fails (stock goes to -10)
      { action: 'decrement', resource: 'product', idFrom: 'productId', field: 'stock', amount: 100 },
    ]
    const result = await executeTransaction(ops, { productId: 'p1' }, store)
    expect(result.success).toBe(false)
    // Rollback: stock back to original 2 (not 3)
    expect(store.get('product')?.get('p1')?.['stock']).toBe(2)
  })

  it('amountFrom reads amount from request body', async () => {
    const store = makeStore({ product: [{ id: 'p1', stock: 20 }] })
    const ops: TxOperation[] = [
      { action: 'decrement', resource: 'product', idFrom: 'productId', field: 'stock', amountFrom: 'quantity' },
    ]
    const result = await executeTransaction(ops, { productId: 'p1', quantity: 4 }, store)
    expect(result.success).toBe(true)
    expect(store.get('product')?.get('p1')?.['stock']).toBe(16)
  })

  it('fails with clear error when record not found', async () => {
    const store = makeStore()
    const ops: TxOperation[] = [{ action: 'delete', resource: 'item', idFrom: 'id' }]
    const result = await executeTransaction(ops, { id: 'nonexistent' }, store)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })
})

// ── Integration test via createRuntime ────────────────────────────────────────

const txSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'tx-test',
  resources: [
    {
      name: 'Product',
      fields: {
        name:  { type: 'string', required: true },
        stock: { type: 'integer', required: true, min: 0 },
      },
    },
    {
      name: 'Purchase',
      fields: {
        productId: { type: 'uuid', required: true },
        quantity:  { type: 'integer', required: true, min: 1 },
      },
      transactions: [
        {
          trigger: 'POST',
          operations: [
            { action: 'decrement', resource: 'product', idFrom: 'productId', field: 'stock', amountFrom: 'quantity' },
          ],
        },
      ],
    },
  ],
}

const { app: txApp } = createRuntime(txSpec, { enableLogging: false, enableDocs: false })

describe('Transaction via createRuntime', () => {
  let productId: string

  it('setup — creates a product with stock 5', async () => {
    const res = await txApp.request('/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Widget', stock: 5 }),
    })
    const body = await res.json() as { data: { id: string } }
    productId = body.data.id
    expect(res.status).toBe(201)
  })

  it('POST /purchases — decrements product.stock', async () => {
    const res = await txApp.request('/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, quantity: 2 }),
    })
    expect(res.status).toBe(201)

    const product = await txApp.request(`/products/${productId}`)
    const pb = await product.json() as { data: { stock: number } }
    expect(pb.data.stock).toBe(3)
  })

  it('POST /purchases — returns 409 when stock would go negative', async () => {
    const res = await txApp.request('/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, quantity: 100 }),
    })
    expect(res.status).toBe(409)
  })
})
