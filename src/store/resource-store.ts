import type { DataStore, ResourceMap } from '../types/store.js'

/**
 * Storage abstraction for a SINGLE user-defined resource collection (e.g. all
 * `Product` rows, all `Todo` rows). This is the seam that lets the REST CRUD
 * handlers stay agnostic of where the data physically lives: an in-memory `Map`
 * in dev/test, or a real database (Prisma) in production.
 *
 * Mirrors the auth pattern (`ApiKeyStore` → `MemoryApiKeyStore` /
 * `PrismaApiKeyStore`) but for business resources.
 *
 * Every method is async so that a Prisma-backed implementation can await the
 * database. The handlers fetch the working set via `list()` and then apply
 * filtering / sorting / pagination / `?include=` IN MEMORY, exactly as they did
 * against the raw `Map` — so this first cut keeps behaviour identical while
 * making writes durable. (Pushing filters down into the query engine is a
 * later optimisation, out of scope here.)
 */
export interface ResourceStore {
  /** Every record in the collection, unordered. */
  list(): Promise<Array<Record<string, unknown>>>
  /** A single record by id, or `undefined` when it does not exist. */
  get(id: string): Promise<Record<string, unknown> | undefined>
  /** Persist a brand-new record keyed by `id`. Returns the stored record. */
  create(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Replace the record at `id` with `data`. Returns the stored record. */
  update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Remove the record at `id`. Returns `true` when a row was actually removed. */
  delete(id: string): Promise<boolean>
}

/**
 * Hands out a {@link ResourceStore} per resource name. `createRuntime` resolves
 * exactly one provider (Memory or Prisma) and `generateRoutes` asks it for the
 * store of each resource as it mounts the routes.
 */
export interface ResourceStoreProvider {
  /** Returns the store backing `resourceName` (e.g. "Product", "OrderItem"). */
  for(resourceName: string): ResourceStore
}

/**
 * In-memory store over a plain `Map<id, record>`. Behaviour is byte-for-byte
 * identical to the historical raw-`Map` access in the route handlers — it is
 * just the same `Map`, now behind the interface.
 *
 * Volatile: everything is lost when the process restarts. This is the default
 * for dev / test / no-database runs.
 */
export class MemoryResourceStore implements ResourceStore {
  constructor(private readonly map: ResourceMap) {}

  async list(): Promise<Array<Record<string, unknown>>> {
    return Array.from(this.map.values())
  }

  async get(id: string): Promise<Record<string, unknown> | undefined> {
    return this.map.get(id)
  }

  async create(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.map.set(id, data)
    return data
  }

  async update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.map.set(id, data)
    return data
  }

  async delete(id: string): Promise<boolean> {
    return this.map.delete(id)
  }
}

/**
 * Memory provider. Backed by the runtime's existing `DataStore` (the
 * `Map<resourceKey, Map<id, record>>` created in `createRuntime`). Crucially it
 * returns stores over the SAME underlying maps the rest of the runtime
 * (relations, transactions, custom endpoints) already reads and writes — so
 * memory mode stays perfectly consistent and regression-free.
 */
export class MemoryResourceStoreProvider implements ResourceStoreProvider {
  constructor(private readonly store: DataStore) {}

  for(resourceName: string): ResourceStore {
    const key = resourceName.toLowerCase()
    let map = this.store.get(key)
    if (!map) {
      map = new Map()
      this.store.set(key, map)
    }
    return new MemoryResourceStore(map)
  }
}
