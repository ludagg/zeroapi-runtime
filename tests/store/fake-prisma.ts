/**
 * A faithful-enough fake of a Prisma client for testing the runtime's
 * Prisma-mode paths WITHOUT a real database / @prisma/client.
 *
 * IMPORTANT CAVEAT (acknowledged): this double mirrors Prisma's DOCUMENTED
 * semantics — guarded `updateMany`, interactive `$transaction` rollback, native
 * `include` resolution — but it is still a hand-written model. A green test here
 * proves the runtime emits the right calls and reacts correctly to their
 * results; it does NOT prove behaviour against a real Postgres/SQLite engine
 * (true multi-process row-lock concurrency in particular is the database's job).
 *
 * To emulate database isolation, `$transaction` is SERIALIZED (run one at a
 * time) and snapshots/rolls back on throw — which is what lets a guarded
 * decrement produce "1 winner / N-1 losers" under concurrent requests.
 */

type Row = Record<string, unknown>

/** Describes one relation field for native include resolution. */
export interface FakeRelation {
  /** The relation field name as it appears in the Prisma model / include tree. */
  field: string
  /** Target delegate (camelCase model key, e.g. "user", "orderItem"). */
  target: string
  /** 'toOne' reads a single related row via a local FK; 'toMany' scans the target. */
  kind: 'toOne' | 'toMany'
  /** FK column. For toOne it lives on THIS row; for toMany it lives on the target row. */
  fk: string
}

export type FakeRelationMap = Record<string, FakeRelation[]>

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const val = row[key]
    if (cond !== null && typeof cond === 'object') {
      const c = cond as Record<string, unknown>
      if ('gte' in c && !(Number(val) >= Number(c['gte']))) return false
      if ('gt' in c && !(Number(val) > Number(c['gt']))) return false
      if ('lte' in c && !(Number(val) <= Number(c['lte']))) return false
      if ('lt' in c && !(Number(val) < Number(c['lt']))) return false
      if ('equals' in c && val !== c['equals']) return false
    } else if (val !== cond) {
      return false
    }
  }
  return true
}

function applyData(row: Row, data: Row): void {
  for (const [key, val] of Object.entries(data)) {
    if (val !== null && typeof val === 'object') {
      const op = val as Record<string, unknown>
      if ('increment' in op) { row[key] = Number(row[key] ?? 0) + Number(op['increment']); continue }
      if ('decrement' in op) { row[key] = Number(row[key] ?? 0) - Number(op['decrement']); continue }
      if ('set' in op) { row[key] = op['set']; continue }
    }
    row[key] = val
  }
}

/** An undo closure recorded by a transaction before it mutates a row. */
type Undo = () => void

export class FakeDelegate {
  readonly rows = new Map<string, Row>()

  constructor(
    private readonly model: string,
    private readonly client: FakePrismaClient,
    /** When set, mutations record an undo here for transactional rollback. */
    private readonly journal?: Undo[],
  ) {}

  /** A view of this delegate that journals its writes into `journal`. */
  withJournal(journal: Undo[]): FakeDelegate {
    const view = new FakeDelegate(this.model, this.client, journal)
    // Share the SAME underlying rows map — a transaction reads/writes live data.
    ;(view as unknown as { rows: Map<string, Row> }).rows = this.rows
    return view
  }

  private record(undo: Undo): void {
    this.journal?.push(undo)
  }

  async findMany(args?: { where?: Record<string, unknown>; include?: Record<string, unknown> }): Promise<Row[]> {
    let out = Array.from(this.rows.values())
    if (args?.where) out = out.filter((r) => matchesWhere(r, args.where!))
    return out.map((r) => this.client.resolveIncludes(this.model, clone(r), args?.include))
  }

  async findUnique(args: { where: { id: string }; include?: Record<string, unknown> }): Promise<Row | null> {
    const row = this.rows.get(args.where.id)
    if (!row) return null
    return this.client.resolveIncludes(this.model, clone(row), args.include)
  }

  async create(args: { data: Row }): Promise<Row> {
    const row = clone(args.data)
    const id = row['id'] as string
    this.record(() => { this.rows.delete(id) })
    this.rows.set(id, row)
    return clone(row)
  }

  async update(args: { where: { id: string }; data: Row }): Promise<Row> {
    const row = this.rows.get(args.where.id)
    if (!row) throw new Error(`Record to update not found (${this.model} ${args.where.id})`)
    const before = clone(row)
    this.record(() => { this.rows.set(args.where.id, before) })
    applyData(row, args.data)
    return clone(row)
  }

  async updateMany(args: { where: Record<string, unknown>; data: Row }): Promise<{ count: number }> {
    let count = 0
    for (const [id, row] of this.rows) {
      if (matchesWhere(row, args.where)) {
        const before = clone(row)
        this.record(() => { this.rows.set(id, before) })
        applyData(row, args.data)
        count++
      }
    }
    return { count }
  }

  async delete(args: { where: { id: string } }): Promise<Row> {
    const row = this.rows.get(args.where.id)
    if (!row) throw new Error(`Record to delete does not exist (${this.model} ${args.where.id})`)
    const before = clone(row)
    this.record(() => { this.rows.set(args.where.id, before) })
    this.rows.delete(args.where.id)
    return clone(row)
  }

  async count(): Promise<number> {
    return this.rows.size
  }
}

export class FakePrismaClient {
  private readonly delegates = new Map<string, FakeDelegate>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    models: string[],
    private readonly relations: FakeRelationMap = {},
  ) {
    for (const m of models) {
      const d = new FakeDelegate(m, this)
      this.delegates.set(m, d)
      // Expose as a property so `client[model]` works like a real PrismaClient.
      ;(this as unknown as Record<string, unknown>)[m] = d
    }
  }

  delegate(model: string): FakeDelegate {
    const d = this.delegates.get(model)
    if (!d) throw new Error(`FakePrismaClient: no delegate "${model}"`)
    return d
  }

  /** Resolves a Prisma-style `include` tree against the in-memory rows. */
  resolveIncludes(model: string, row: Row, include?: Record<string, unknown>): Row {
    if (!include) return row
    const rels = this.relations[model] ?? []
    for (const [field, sub] of Object.entries(include)) {
      if (sub === false) continue
      const rel = rels.find((r) => r.field === field)
      if (!rel) continue
      const nested = typeof sub === 'object' && sub !== null
        ? (sub as { include?: Record<string, unknown> }).include
        : undefined
      const targetDelegate = this.delegate(rel.target)
      if (rel.kind === 'toOne') {
        const fkVal = row[rel.fk]
        const target = fkVal != null ? targetDelegate.rows.get(fkVal as string) : undefined
        row[field] = target ? this.resolveIncludes(rel.target, clone(target), nested) : null
      } else {
        const id = row['id']
        const children = Array.from(targetDelegate.rows.values())
          .filter((r) => r[rel.fk] === id)
          .map((r) => this.resolveIncludes(rel.target, clone(r), nested))
        row[field] = children
      }
    }
    return row
  }

  /**
   * Interactive transaction. SERIALIZED (to emulate database isolation) and
   * rolled back precisely via a per-transaction journal: only the rows THIS
   * transaction wrote are undone on throw, so concurrent non-transactional
   * writes to other rows/models are never clobbered — exactly like a real DB.
   */
  async $transaction<T>(fn: (tx: Record<string, FakeDelegate>) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const journal: Undo[] = []
      const tx: Record<string, FakeDelegate> = {}
      for (const [name, d] of this.delegates) tx[name] = d.withJournal(journal)
      try {
        return await fn(tx)
      } catch (err) {
        for (let i = journal.length - 1; i >= 0; i--) journal[i]!()
        throw err
      }
    })
    // Keep the chain alive regardless of this txn's outcome.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}
