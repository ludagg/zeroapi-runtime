/* Proof: memory-mode transactions are serialized (no interleaving corruption).
 *
 * Realistic 2-op transaction [create Purchase, decrement Product.stock] — the
 * same shape as the P0-1 concurrency test. Two concurrent buyers on stock=1:
 * without a lock, the loser's rollback restores a snapshot taken BEFORE the
 * winner's decrement, ERASING it (final stock=1 with 1 purchase — corrupt).
 * The per-store mutex serializes them → final stock=0 (correct).
 *
 * Memory-only (no database). Run with tsx. */
import { executeTransaction } from '../src/transactions/executor.js'
import type { TxOperation } from '../src/types/spec.js'

type Row = Record<string, unknown>
type Store = Map<string, Map<string, Row>>

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

const OPS: TxOperation[] = [
  { action: 'create', resource: 'Purchase' },
  { action: 'decrement', resource: 'Product', idFrom: 'productId', field: 'stock', amount: 1 },
]

function makeStore(initialStock: number): { store: Store; productId: string } {
  const productId = 'p1'
  const store: Store = new Map()
  store.set('product', new Map([[productId, { id: productId, stock: initialStock }]]))
  store.set('purchase', new Map())
  return { store, productId }
}
const stockOf = (store: Store) => Number(store.get('product')!.get('p1')!['stock'])
const purchaseCount = (store: Store) => store.get('purchase')!.size

// ── "BEFORE": faithful copy of the OLD executor (snapshot/restore, NO lock) ──
async function unlockedTransaction(operations: TxOperation[], body: Row, store: Store) {
  const snapshot = new Map<string, Map<string, Row>>()
  for (const key of new Set(operations.map((o) => o.resource.toLowerCase()))) {
    const existing = store.get(key)
    snapshot.set(key, existing ? new Map(existing) : new Map())
  }
  try {
    for (const op of operations) await unlockedOp(op, body, store) // `await` per op → interleave window
    return { success: true }
  } catch {
    for (const [key, snap] of snapshot.entries()) store.set(key, snap)
    return { success: false }
  }
}
// eslint-disable-next-line @typescript-eslint/require-await
async function unlockedOp(op: TxOperation, body: Row, store: Store) {
  const bucket = store.get(op.resource.toLowerCase()) ?? new Map()
  store.set(op.resource.toLowerCase(), bucket)
  if (op.action === 'create') {
    const id = `${Math.random()}`
    bucket.set(id, { id, ...body })
  } else if (op.action === 'decrement') {
    const id = body[op.idFrom!] as string
    const row = bucket.get(id)!
    const current = Number(row[op.field!])
    if (current - (op.amount ?? 1) < 0) throw new Error('below zero')
    bucket.set(id, { ...row, [op.field!]: current - (op.amount ?? 1) })
  }
}

async function main() {
  // ── 1. Deterministic: stock=1, two concurrent buyers ─────────────────────
  {
    const { store, productId } = makeStore(1)
    await Promise.all([
      unlockedTransaction(OPS, { productId }, store),
      unlockedTransaction(OPS, { productId }, store),
    ])
    const finalStock = stockOf(store)
    const purchases = purchaseCount(store)
    check('BEFORE (no lock): stock=1 + 2 buyers → CORRUPT (stock not 0, invariant broken)',
      finalStock !== 0 || finalStock + purchases !== 1,
      `finalStock=${finalStock} purchases=${purchases} (invariant stock+purchases=${finalStock + purchases}, expected 1)`)
  }
  {
    const { store, productId } = makeStore(1)
    await Promise.all([
      executeTransaction(OPS, { productId }, store),
      executeTransaction(OPS, { productId }, store),
    ])
    const finalStock = stockOf(store)
    const purchases = purchaseCount(store)
    check('AFTER (per-store lock): stock=1 + 2 buyers → stock=0, exactly 1 purchase',
      finalStock === 0 && purchases === 1 && finalStock + purchases === 1,
      `finalStock=${finalStock} purchases=${purchases}`)
  }

  // ── 2. 10 concurrent buyers on stock=5 — invariant stock+successes==initial ──
  {
    const { store, productId } = makeStore(5)
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => executeTransaction(OPS, { productId }, store)),
    )
    const successes = outcomes.filter((o) => o.success).length
    const finalStock = stockOf(store)
    check('AFTER: 10 concurrent on stock=5 → exactly 5 succeed, stock=0',
      successes === 5 && finalStock === 0,
      `successes=${successes} finalStock=${finalStock}`)
    check('AFTER: invariant holds — finalStock + successes === initial (5)',
      finalStock + successes === 5,
      `${finalStock} + ${successes} = ${finalStock + successes} (expected 5)`)
  }

  // ── 3. Show BEFORE violates the invariant under contention (racy → repeat) ──
  {
    let violations = 0
    for (let trial = 0; trial < 50; trial++) {
      const { store, productId } = makeStore(5)
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => unlockedTransaction(OPS, { productId }, store)),
      )
      const successes = outcomes.filter((o) => o.success).length
      if (stockOf(store) + successes !== 5) violations++
    }
    check('BEFORE: invariant VIOLATED under contention (rollback erases concurrent commits)',
      violations > 0, `violations=${violations}/50 trials`)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
