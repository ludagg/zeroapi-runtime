import { randomUUID } from 'crypto'
import type { TxOperation } from '../types/spec.js'
import type { DataStore } from '../generators/routes.js'

type Row = Record<string, unknown>

export interface TxResult {
  success: boolean
  results: Row[]
  error?: string
  failedOperation?: string
}

/**
 * Executes a list of operations atomically against the in-memory store.
 * On any failure the entire set of side-effects is rolled back (snapshot/restore).
 *
 * Equivalent to prisma.$transaction() for the in-memory runtime.
 */
export async function executeTransaction(
  operations: TxOperation[],
  requestBody: Record<string, unknown>,
  store: DataStore
): Promise<TxResult> {
  // Snapshot affected store sections
  const snapshot = new Map<string, Map<string, Row>>()
  const resourceKeys = new Set(operations.map((op) => op.resource.toLowerCase()))
  for (const key of resourceKeys) {
    const existing = store.get(key)
    snapshot.set(key, existing ? new Map(existing) : new Map())
  }

  const results: Row[] = []

  try {
    for (const op of operations) {
      const result = await executeOperation(op, requestBody, store)
      results.push(result)
    }
    return { success: true, results }
  } catch (err) {
    // Rollback — restore snapshots
    for (const [key, snap] of snapshot.entries()) {
      store.set(key, snap)
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      results: [],
      error: message,
      failedOperation: `${operations.find((op) => op.action)}`,
    }
  }
}

async function executeOperation(
  op: TxOperation,
  body: Record<string, unknown>,
  store: DataStore
): Promise<Row> {
  const key = op.resource.toLowerCase()
  if (!store.has(key)) store.set(key, new Map())
  const resourceStore = store.get(key)!

  switch (op.action) {
    case 'create': {
      const id = randomUUID()
      const now = new Date().toISOString()
      const record: Row = { id, createdAt: now, updatedAt: now, ...body }
      resourceStore.set(id, record)
      return record
    }

    case 'update': {
      const id = resolveId(op, body)
      const existing = resourceStore.get(id)
      if (!existing) throw new Error(`${op.resource} with id "${id}" not found`)
      const updated: Row = { ...existing, ...body, updatedAt: new Date().toISOString() }
      resourceStore.set(id, updated)
      return updated
    }

    case 'delete': {
      const id = resolveId(op, body)
      const existing = resourceStore.get(id)
      if (!existing) throw new Error(`${op.resource} with id "${id}" not found`)
      resourceStore.delete(id)
      return existing
    }

    case 'decrement': {
      const id = resolveId(op, body)
      const existing = resourceStore.get(id)
      if (!existing) throw new Error(`${op.resource} with id "${id}" not found`)

      const field = op.field
      if (!field) throw new Error(`"field" is required for decrement operation on ${op.resource}`)

      const amount = resolveAmount(op, body)
      const current = Number(existing[field] ?? 0)

      if (current - amount < 0) {
        throw new Error(
          `Cannot decrement ${op.resource}.${field}: would go below zero (current: ${current}, amount: ${amount})`
        )
      }

      const updated: Row = { ...existing, [field]: current - amount, updatedAt: new Date().toISOString() }
      resourceStore.set(id, updated)
      return updated
    }

    case 'increment': {
      const id = resolveId(op, body)
      const existing = resourceStore.get(id)
      if (!existing) throw new Error(`${op.resource} with id "${id}" not found`)

      const field = op.field
      if (!field) throw new Error(`"field" is required for increment operation on ${op.resource}`)

      const amount = resolveAmount(op, body)
      const current = Number(existing[field] ?? 0)

      const updated: Row = { ...existing, [field]: current + amount, updatedAt: new Date().toISOString() }
      resourceStore.set(id, updated)
      return updated
    }
  }
}

function resolveId(op: TxOperation, body: Record<string, unknown>): string {
  const id = op.idFrom ? (body[op.idFrom] as string) : (body['id'] as string)
  if (!id) throw new Error(`Cannot resolve ID for ${op.resource}: idFrom="${op.idFrom}" not found in body`)
  return id
}

function resolveAmount(op: TxOperation, body: Record<string, unknown>): number {
  if (op.amountFrom) {
    const v = Number(body[op.amountFrom])
    if (!Number.isFinite(v)) throw new Error(`amountFrom "${op.amountFrom}" is not a number`)
    return v
  }
  return op.amount ?? 1
}
