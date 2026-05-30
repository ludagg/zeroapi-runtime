import { randomUUID } from 'crypto'
import type { TxOperation } from '../types/spec.js'
import { prismaResourceDelegateName } from '../store/prisma-resource-store.js'
import type { TxResult } from './executor.js'

type Row = Record<string, unknown>

/**
 * The slice of a Prisma model delegate the transactional executor uses. Kept
 * structural (no `@prisma/client` dependency). `updateMany` is the key to a
 * concurrency-safe guarded decrement.
 */
export interface PrismaTxDelegate {
  findUnique(args: { where: { id: string } }): Promise<Row | null>
  create(args: { data: Row }): Promise<Row>
  update(args: { where: { id: string }; data: Row }): Promise<Row>
  delete(args: { where: { id: string } }): Promise<Row>
  updateMany(args: { where: Record<string, unknown>; data: Row }): Promise<{ count: number }>
}

/**
 * A Prisma client exposing interactive `$transaction`. The callback receives a
 * transactional client (same delegate shape) and everything inside it commits
 * atomically — or rolls back entirely if the callback throws.
 */
export interface PrismaTransactionalClient {
  $transaction<T>(fn: (tx: Record<string, PrismaTxDelegate>) => Promise<T>): Promise<T>
}

/**
 * Prisma-mode counterpart of `executeTransaction`. Runs all operations inside a
 * single `prisma.$transaction(...)` so they commit or roll back together at the
 * database — real ACID, not a Map snapshot.
 *
 * The guarded `decrement` is the important one for correctness under
 * concurrency: instead of read-then-write (which races), it issues a single
 * conditional `updateMany({ where: { id, field: { gte: amount } }, data: {
 * field: { decrement: amount } } })`. The database evaluates the guard and the
 * write atomically under a row lock, so out of N concurrent requests exactly
 * the ones with enough stock succeed; the rest see `count === 0` and the whole
 * transaction rolls back → the route returns 409. This holds across processes,
 * which a single-process Map can never guarantee.
 */
export async function executePrismaTransaction(
  operations: TxOperation[],
  body: Record<string, unknown>,
  client: PrismaTransactionalClient,
): Promise<TxResult> {
  try {
    const results = await client.$transaction(async (tx) => {
      const out: Row[] = []
      for (const op of operations) {
        out.push(await executeOne(op, body, tx))
      }
      return out
    })
    return { success: true, results }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failed = operations.find((op) => op.action)
    return {
      success: false,
      results: [],
      error: message,
      failedOperation: failed ? `${failed.action} ${failed.resource}` : undefined,
    }
  }
}

async function executeOne(
  op: TxOperation,
  body: Record<string, unknown>,
  tx: Record<string, PrismaTxDelegate>,
): Promise<Row> {
  const delegate = tx[prismaResourceDelegateName(op.resource)]
  if (!delegate) {
    throw new Error(`Transaction: no Prisma model delegate for "${op.resource}"`)
  }

  switch (op.action) {
    case 'create': {
      const now = new Date().toISOString()
      return delegate.create({ data: { id: randomUUID(), createdAt: now, updatedAt: now, ...body } })
    }

    case 'update': {
      const id = resolveId(op, body)
      return delegate.update({ where: { id }, data: { ...body, updatedAt: new Date().toISOString() } })
    }

    case 'delete': {
      const id = resolveId(op, body)
      return delegate.delete({ where: { id } })
    }

    case 'increment': {
      const id = resolveId(op, body)
      const field = requireField(op)
      const amount = resolveAmount(op, body)
      return delegate.update({ where: { id }, data: { [field]: { increment: amount } } })
    }

    case 'decrement': {
      const id = resolveId(op, body)
      const field = requireField(op)
      const amount = resolveAmount(op, body)
      // Guarded, atomic, concurrency-safe: only decrement when enough remains.
      const res = await delegate.updateMany({
        where: { id, [field]: { gte: amount } },
        data: { [field]: { decrement: amount } },
      })
      if (res.count === 0) {
        throw new Error(
          `Cannot decrement ${op.resource}.${field}: insufficient value (need ${amount})`,
        )
      }
      const row = await delegate.findUnique({ where: { id } })
      if (!row) throw new Error(`${op.resource} with id "${id}" not found`)
      return row
    }

    default:
      throw new Error(`Unsupported transaction action: ${String(op.action)}`)
  }
}

function resolveId(op: TxOperation, body: Record<string, unknown>): string {
  const id = op.idFrom ? (body[op.idFrom] as string) : (body['id'] as string)
  if (!id) throw new Error(`Cannot resolve ID for ${op.resource}: idFrom="${op.idFrom}" not found in body`)
  return id
}

function requireField(op: TxOperation): string {
  if (!op.field) throw new Error(`"field" is required for ${op.action} on ${op.resource}`)
  return op.field
}

function resolveAmount(op: TxOperation, body: Record<string, unknown>): number {
  if (op.amountFrom) {
    const v = Number(body[op.amountFrom])
    if (!Number.isFinite(v)) throw new Error(`amountFrom "${op.amountFrom}" is not a number`)
    return v
  }
  return op.amount ?? 1
}
