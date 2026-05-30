import type { ResourceStore, ResourceStoreProvider, ReadOptions, PrismaInclude } from './resource-store.js'

/**
 * The slice of a Prisma model delegate we rely on for basic CRUD. Structural,
 * so we never pull `@prisma/client` in as a hard dependency — any generated
 * client whose model delegates expose these methods satisfies the type. This is
 * the same trick used by `PrismaApiKeyStore`'s `PrismaApiKeyDelegate`.
 */
export interface PrismaResourceDelegate {
  findMany(args?: { include?: PrismaInclude }): Promise<Array<Record<string, unknown>>>
  findUnique(args: { where: { id: string }; include?: PrismaInclude }): Promise<Record<string, unknown> | null>
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<Record<string, unknown>>
  delete(args: { where: { id: string } }): Promise<Record<string, unknown>>
}

/**
 * A Prisma client viewed only as a bag of model delegates keyed by their
 * camelCase delegate name (`prisma.product`, `prisma.orderItem`, ...). A real
 * `PrismaClient` is assignable to this via a structural cast at the call site.
 */
export interface PrismaResourceLikeClient {
  [delegateName: string]: PrismaResourceDelegate
}

/**
 * Maps a spec resource name to the Prisma client delegate property.
 *
 * Prisma lower-cases ONLY the first character of the model name for the client
 * delegate, preserving the rest of the casing:
 *
 *   Product   → prisma.product
 *   Category  → prisma.category
 *   OrderItem → prisma.orderItem   (NOT `orderitem`)
 *
 * Using `resourceName.toLowerCase()` would break composite names like
 * `OrderItem`, so we deliberately only touch the first letter.
 */
export function prismaResourceDelegateName(resourceName: string): string {
  if (resourceName.length === 0) return resourceName
  return resourceName.charAt(0).toLowerCase() + resourceName.slice(1)
}

/**
 * Prisma-backed implementation of {@link ResourceStore} for a single model.
 * Persists rows to the database so user resources survive restarts and are
 * shared across instances.
 *
 * Scope note: this is BASIC CRUD only. Relations / manyToMany / Prisma
 * `$transaction` integration are handled by later chantiers — the runtime still
 * resolves those against the in-memory `DataStore` for now.
 */
export class PrismaResourceStore implements ResourceStore {
  constructor(
    private readonly client: PrismaResourceLikeClient,
    private readonly delegateName: string,
  ) {}

  /**
   * Resolve the model delegate LAZILY — only when an actual CRUD call happens,
   * never at route-mount time. This keeps construction side-effect free: a
   * client that only implements some delegates (e.g. an API-key-only mock) can
   * still back the resources it does cover, and a genuine misconfiguration
   * surfaces a clear error at the point of use rather than at startup.
   */
  private delegate(): PrismaResourceDelegate {
    const delegate = this.client[this.delegateName]
    if (!delegate || typeof delegate.findMany !== 'function') {
      throw new Error(
        `PrismaResourceStore: the Prisma client has no model delegate "${this.delegateName}". ` +
        `Make sure the model exists in your schema.prisma and that you ran \`prisma generate\`.`,
      )
    }
    return delegate
  }

  async list(opts?: ReadOptions): Promise<Array<Record<string, unknown>>> {
    return this.delegate().findMany(opts?.include ? { include: opts.include } : undefined)
  }

  async get(id: string, opts?: ReadOptions): Promise<Record<string, unknown> | undefined> {
    const row = await this.delegate().findUnique(
      opts?.include ? { where: { id }, include: opts.include } : { where: { id } },
    )
    return row ?? undefined
  }

  async create(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    // The handler already stamped `id` into `data`; pass it through explicitly
    // so the database row shares the same primary key the API returned.
    return this.delegate().create({ data: { ...data, id } })
  }

  async update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    // `id` is the immutable primary key — it identifies the row via `where`, so
    // strip it from the update payload (Prisma rejects changing a PK).
    const { id: _omitId, ...rest } = data
    return this.delegate().update({ where: { id }, data: rest })
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.delegate().delete({ where: { id } })
      return true
    } catch {
      // Prisma throws P2025 when the row is absent — mirror Map.delete()'s
      // "nothing removed" by returning false rather than surfacing an error.
      return false
    }
  }
}

/**
 * Prisma provider with per-resource graceful fallback.
 *
 * For each resource it checks whether the client exposes a matching model
 * delegate (a plain property read — no database I/O). When present, the
 * resource is persisted via {@link PrismaResourceStore}. When absent (e.g. a
 * partial/mock client, or a model that simply isn't in the schema yet) it falls
 * back to the supplied provider (in-memory), so the runtime never refuses to
 * serve a route just because one model is missing.
 *
 * A correctly generated client has a delegate for every resource model (the
 * schema generator emits them all), so in real deployments everything persists.
 */
export class PrismaResourceStoreProvider implements ResourceStoreProvider {
  constructor(
    private readonly client: PrismaResourceLikeClient,
    private readonly fallback?: ResourceStoreProvider,
  ) {}

  /** The Prisma client — enables native `include` / `$transaction` paths. */
  prismaClient(): PrismaResourceLikeClient | undefined {
    return this.client
  }

  for(resourceName: string): ResourceStore {
    const delegateName = prismaResourceDelegateName(resourceName)
    const delegate = this.client[delegateName]
    const usable = !!delegate && typeof delegate.findMany === 'function'
    if (usable) return new PrismaResourceStore(this.client, delegateName)
    if (this.fallback) return this.fallback.for(resourceName)
    // No delegate and no fallback: defer the clear error to the first CRUD call.
    return new PrismaResourceStore(this.client, delegateName)
  }
}
