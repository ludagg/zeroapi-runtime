import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type {
  ZeroAPISpec, ResourceDefinition, CrudAction, CustomEndpointDef, PermissionAction, TxOperation,
} from '../types/spec.js'
import type { DataStore, ResourceMap } from '../types/store.js'
import type { ResourceStore, ResourceStoreProvider, ReadOptions } from '../store/resource-store.js'
import { MemoryResourceStoreProvider } from '../store/resource-store.js'
import type { HandlerFn } from '../hooks/types.js'
import { generateZodSchemas, type ResourceSchemas } from './validation.js'
import { createPermissionMiddleware } from '../rbac/permissions.js'
import {
  buildResourcePermissionGuard,
  getOwnershipFilter,
  getRequesterIdentity,
  resourceHasOwnOnly,
} from '../rbac/resource-permissions.js'
import { parseQueryParams, toPrismaQuery } from '../query/builder.js'
import { applyQuery, type PaginationMeta } from '../query/apply.js'
import {
  applyIncludes, extractNestedRelations, persistNestedRelations, persistNestedRelationsPrisma,
  validateIncludes, type SystemResourceResolvers,
} from '../relations/index.js'
import { buildPrismaInclude, extractM2MFilters } from '../relations/prisma-include.js'
import type { PrismaInclude } from '../store/resource-store.js'
import {
  partitionIncludes, resolveAggregates, applyAggregates, type PrismaAggregateClient,
} from '../aggregates/index.js'
import { executeTransaction } from '../transactions/executor.js'
import { executePrismaTransaction, type PrismaTransactionalClient } from '../transactions/prisma-executor.js'
import { checkTransition } from '../state/state-machine.js'
import { processFileFields } from '../upload/index.js'
import { toPlural } from '../utils/plural.js'
import { executeHook } from '../hooks/runner.js'

export type { DataStore, ResourceMap }
export type { ResourceStore, ResourceStoreProvider }

/** Phase 3.3: callback invoked after a successful create/update/delete. */
export type EmitWebhookFn = (eventType: string, payload: unknown) => void

const DEFAULT_ENDPOINTS: CrudAction[] = ['list', 'create', 'read', 'update', 'delete']

function composeGuard(guards: MiddlewareHandler[]): MiddlewareHandler | null {
  if (guards.length === 0) return null
  if (guards.length === 1) return guards[0] ?? null
  return async (c, next) => {
    let i = 0
    const dispatch = async (): Promise<void> => {
      if (i >= guards.length) { await next(); return }
      const mw = guards[i++]
      if (mw) await mw(c, dispatch)
    }
    await dispatch()
  }
}

/**
 * Maps a CRUD-style route action to the permission action it represents.
 * Mirrors the spec: list/read → "read", create → "create", update → "update", delete → "delete".
 */
function toPermissionAction(action: 'list' | 'read' | 'create' | 'update' | 'delete'): PermissionAction {
  return action === 'list' ? 'read' : action
}

function buildGuard(
  resource: ResourceDefinition,
  action: 'list' | 'read' | 'create' | 'update' | 'delete',
  spec: ZeroAPISpec,
  globalAuth?: MiddlewareHandler
): MiddlewareHandler | null {
  // Modern permissions block takes precedence — when present it covers auth + RBAC.
  const permGuard = buildResourcePermissionGuard(spec, resource, toPermissionAction(action), globalAuth)
  if (permGuard) return permGuard

  // Legacy: resource-level rbac block (read/write/delete).
  const legacyAction: 'read' | 'write' | 'delete' =
    action === 'list' || action === 'read' ? 'read' :
    action === 'delete' ? 'delete' : 'write'

  const guards: MiddlewareHandler[] = []
  if (resource.auth?.required && globalAuth) guards.push(globalAuth)
  const allowed = resource.rbac?.[legacyAction]
  if (allowed && allowed.length > 0) guards.push(createPermissionMiddleware(allowed, spec))
  return composeGuard(guards)
}

function buildCustomGuard(
  endpoint: CustomEndpointDef,
  spec: ZeroAPISpec,
  globalAuth?: MiddlewareHandler
): MiddlewareHandler | null {
  const guards: MiddlewareHandler[] = []
  if ((endpoint.auth || (endpoint.roles?.length ?? 0) > 0) && globalAuth) {
    guards.push(globalAuth)
  }
  if (endpoint.roles?.length) guards.push(createPermissionMiddleware(endpoint.roles, spec))
  return composeGuard(guards)
}

type RouteHandler = (c: Context) => Response | Promise<Response>

function mount(
  router: Hono,
  method: 'get' | 'post' | 'put' | 'delete' | 'patch',
  path: string,
  guard: MiddlewareHandler | null,
  handler: RouteHandler
): void {
  if (guard) { router[method](path, guard, handler) }
  else       { router[method](path, handler)         }
}

function validationError(
  c: Context,
  issues: Array<{ path: (string | number)[]; message: string }>
): Response {
  return c.json(
    { error: 'Validation failed', details: issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    422
  )
}

function hasFileFields(resource: ResourceDefinition): boolean {
  return Object.values(resource.fields).some((f) => f.type === 'file')
}

async function readBody(
  c: Context,
  resource: ResourceDefinition,
  uploadDir?: string
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; res: Response }> {
  const ct = c.req.header('content-type') ?? ''

  if (ct.includes('multipart/form-data') || (hasFileFields(resource) && !ct.includes('application/json'))) {
    let formData: Record<string, File | string | File[] | string[]>
    try {
      formData = (await c.req.parseBody()) as Record<string, File | string | File[] | string[]>
    } catch {
      return { ok: false, res: c.json({ error: 'Failed to parse multipart body' }, 400) }
    }
    const { body, errors } = await processFileFields(formData, resource.fields, uploadDir)
    if (errors.length > 0) {
      return { ok: false, res: c.json({ error: 'File validation failed', details: errors }, 422) }
    }
    return { ok: true, data: body }
  }

  try {
    const data = await c.req.json() as Record<string, unknown>
    return { ok: true, data }
  } catch {
    return { ok: false, res: c.json({ error: 'Request body must be valid JSON' }, 400) }
  }
}

/** Optional constraint applied to a handler by its mount context — used by
 *  nested routes to force a parent FK on writes and filter on reads. */
interface ParentScope {
  field: string
  value: string
}

/**
 * Builds the whitelist of field names usable in `?field[op]=val` filters and
 * `?sort=field`. Anything outside this set yields a 400 "Unknown field".
 *
 * Covers:
 *  - declared resource fields
 *  - reserved server-managed columns (id/createdAt/updatedAt/deletedAt)
 *  - FK columns derived from manyToOne / oneToOne relations
 *  - `userId` (auto-attached by ownOnly RBAC, even when not in `fields`)
 */
function buildAllowedFilterFields(resource: ResourceDefinition): Set<string> {
  const allowed = new Set<string>([
    'id', 'createdAt', 'updatedAt', 'deletedAt', 'userId',
    ...Object.keys(resource.fields),
  ])
  for (const rel of resource.relations ?? []) {
    if (rel.type === 'manyToOne' || rel.type === 'oneToOne') {
      const fk = rel.field ?? `${rel.resource.toLowerCase()}Id`
      allowed.add(fk)
    }
  }
  return allowed
}

// ── Prisma query pushdown (P0-1) ────────────────────────────────────────────
// These helpers translate the parsed query into SQL clauses so the database —
// not Node — does the filtering/searching/sorting/pagination. Memory mode never
// calls them (it keeps `applyQuery`).

const NUMERIC_FILTER_TYPES = new Set(['number', 'integer', 'decimal'])

/**
 * Coerce a raw filter value to the JS type Prisma expects for `fieldType`.
 * Numeric columns → number; boolean → boolean; everything else (string/text/
 * email/url/uuid/enum/json, dates as ISO strings, and FK/id columns whose type
 * is unknown) → string. This prevents Prisma type errors when the URL parser
 * guessed the wrong primitive — e.g. `?sku=12345` on a String column would
 * otherwise reach Prisma as the number 12345 and throw.
 */
function coerceScalarForField(fieldType: string | undefined, raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw
  if (fieldType && NUMERIC_FILTER_TYPES.has(fieldType)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  if (fieldType === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (raw === 'true') return true
    if (raw === 'false') return false
    return raw
  }
  return typeof raw === 'string' ? raw : String(raw)
}

/**
 * In-place type coercion of a Prisma `where` produced by `toPrismaQuery`, using
 * the resource's declared field types. Only equality/comparison/set operators
 * are touched; `contains`/`startsWith`/`endsWith` stay strings (they are only
 * valid on string columns anyway).
 */
function coercePrismaWhereTypes(where: Record<string, unknown>, resource: ResourceDefinition): void {
  for (const [field, condRaw] of Object.entries(where)) {
    if (!condRaw || typeof condRaw !== 'object') continue
    const fieldType = resource.fields[field]?.type
    const cond = condRaw as Record<string, unknown>
    for (const op of ['equals', 'not', 'gt', 'gte', 'lt', 'lte']) {
      if (cond[op] !== undefined) cond[op] = coerceScalarForField(fieldType, cond[op])
    }
    for (const op of ['in', 'notIn']) {
      const arr = cond[op]
      if (Array.isArray(arr)) cond[op] = arr.map((v) => coerceScalarForField(fieldType, v))
    }
  }
}

/**
 * Build a Prisma `{ OR: [...] }` full-text search clause over the resource's
 * `searchable` fields. Case-insensitive `contains` to mirror the in-memory
 * search semantics. Returns undefined when search is disabled / not applicable.
 */
function buildPrismaSearchWhere(
  q: string | undefined,
  resource: ResourceDefinition,
  features?: ZeroAPISpec['features'],
): Record<string, unknown> | undefined {
  if (!q || q.length === 0) return undefined
  if (features?.search?.enabled !== true) return undefined
  const searchable = resource.searchable ?? []
  if (searchable.length === 0) return undefined
  return { OR: searchable.map((f) => ({ [f]: { contains: q, mode: 'insensitive' } })) }
}

/**
 * Best-effort 1-indexed page for cursor mode. Exact for the default `id:asc`
 * ordering (counts rows preceding the cursor with one indexed COUNT); falls
 * back to 1 when a custom sort makes "preceding" ill-defined by id alone, or
 * when `id` is already constrained by a filter. Cursor-mode page is, by design,
 * an approximation — clients paginate via `nextCursor`, not the page number.
 */
async function computeCursorPage(
  store: ResourceStore,
  fullWhere: Record<string, unknown>,
  sorts: Array<{ field: string }>,
  cursorId: string,
  limit: number,
): Promise<number> {
  if (limit <= 0 || sorts.length > 0 || 'id' in fullWhere) return 1
  const preceding = await store.count({ ...fullWhere, id: { lt: cursorId } })
  return Math.floor(preceding / limit) + 1
}

interface ResourceHandlerBundle {
  guards: {
    list:   MiddlewareHandler | null
    read:   MiddlewareHandler | null
    create: MiddlewareHandler | null
    update: MiddlewareHandler | null
    delete: MiddlewareHandler | null
  }
  hasOwnOnly: boolean
  handleList:   (c: Context, parent?: ParentScope) => Promise<Response> | Response
  handleRead:   (c: Context, parent?: ParentScope) => Promise<Response> | Response
  handleCreate: (c: Context, parent?: ParentScope) => Promise<Response>
  handleUpdate: (c: Context, parent?: ParentScope) => Promise<Response>
  handleDelete: (c: Context, parent?: ParentScope) => Promise<Response>
}

function buildResourceHandlerBundle(
  resource: ResourceDefinition,
  store: DataStore,
  provider: ResourceStoreProvider,
  spec: ZeroAPISpec,
  authMiddleware?: MiddlewareHandler,
  uploadDir?: string,
  handlers: Record<string, HandlerFn> = {},
  emitWebhook?: EmitWebhookFn,
  systemResolvers?: SystemResourceResolvers,
): ResourceHandlerBundle {
  const key = resource.name.toLowerCase()
  const lowerName = key
  // Persistence seam: Memory (the shared DataStore map) or Prisma (the DB).
  const resourceStore: ResourceStore = provider.for(resource.name)
  // Prisma client when in Prisma mode — drives the native include + $transaction
  // paths. Undefined in memory mode (the subsystems keep their in-memory path).
  const prismaClient = provider.prismaClient?.()

  // Transactions: real `prisma.$transaction` in Prisma mode (ACID, concurrency
  // safe), the Map-snapshot executor in memory mode. Same TxResult contract.
  const runTransaction = (ops: TxOperation[], body: Record<string, unknown>) =>
    prismaClient
      ? executePrismaTransaction(ops, body, prismaClient as unknown as PrismaTransactionalClient)
      : executeTransaction(ops, body, store)

  const schemas: ResourceSchemas = generateZodSchemas(resource)
  const hasOwnOnly = resourceHasOwnOnly(spec, resource.name)

  const guards = {
    list:   buildGuard(resource, 'list',   spec, authMiddleware),
    read:   buildGuard(resource, 'read',   spec, authMiddleware),
    create: buildGuard(resource, 'create', spec, authMiddleware),
    update: buildGuard(resource, 'update', spec, authMiddleware),
    delete: buildGuard(resource, 'delete', spec, authMiddleware),
  }

  const allowedFilterFields = buildAllowedFilterFields(resource)

  // State machine (optional): forces `initial` on create and validates
  // from→to + role on update. Works in both Memory and Prisma modes since the
  // current state is read from the resolved store before validating.
  const sm = resource.stateMachine

  const handleList = async (c: Context, parent?: ParentScope): Promise<Response> => {
    const paginationFeature = spec.features?.pagination
    const parseOpts: { defaultLimit?: number; maxLimit?: number } = {}
    if (paginationFeature?.defaultLimit !== undefined) parseOpts.defaultLimit = paginationFeature.defaultLimit
    if (paginationFeature?.maxLimit !== undefined)     parseOpts.maxLimit     = paginationFeature.maxLimit
    const query = parseQueryParams(new URL(c.req.url), parseOpts)

    // Phase 2.2: reject unknown operators with a clear 400 instead of silently dropping them.
    if (query.unknownOperators.length > 0) {
      const first = query.unknownOperators[0]
      if (first) {
        return c.json({ error: `Unknown operator: ${first.operator}` }, 400)
      }
    }

    // Prisma mode: pull many-to-many relation filters (e.g. ?hashtag=<id>) out
    // into a native Prisma `where { some }` clause BEFORE the unknown-field
    // check (relation names aren't scalar fields). Scalar filters stay in
    // `query.filters` and are still applied in memory by applyQuery.
    let prismaWhere: Record<string, unknown> | undefined
    if (prismaClient) {
      const { where, remaining } = extractM2MFilters(resource, query.filters, spec)
      if (Object.keys(where).length > 0) {
        prismaWhere = where
        query.filters = remaining
      }
    }

    // Phase 2.2: reject filters/sorts on fields that don't exist on the resource.
    for (const field of Object.keys(query.filters)) {
      if (!allowedFilterFields.has(field)) {
        return c.json({ error: `Unknown field: ${field}` }, 400)
      }
    }
    for (const sortSpec of query.sorts) {
      if (!allowedFilterFields.has(sortSpec.field)) {
        return c.json({ error: `Unknown field: ${sortSpec.field}` }, 400)
      }
    }

    // `?include=` carries both relation includes and opt-in aggregate names.
    const { relationIncludes, aggregateIncludes } = partitionIncludes(resource, query.include)

    // Validate relation includes. In Prisma mode we translate to a native
    // include tree (nested); in memory mode we keep the 1-level validator.
    let prismaInclude: PrismaInclude | undefined
    if (relationIncludes.length > 0) {
      if (prismaClient) {
        const built = buildPrismaInclude(resource, spec, relationIncludes, getRequesterIdentity(c).userId)
        if (!built.ok) return c.json({ error: `Unknown relation: ${built.unknown}` }, 400)
        prismaInclude = built.include
      } else {
        const include = validateIncludes(relationIncludes, resource)
        if (!include.ok) return c.json({ error: `Unknown relation: ${include.unknown}` }, 400)
      }
    }

    const ownership = getOwnershipFilter(c)

    // ── Prisma mode: SQL pushdown (P0-1) ─────────────────────────────────────
    // Filtering, full-text search, sorting and pagination become a single SQL
    // query (WHERE / ORDER BY / LIMIT / OFFSET) plus a SQL COUNT — the database
    // no longer ships the whole table to Node. Row-level scope (ownOnly /
    // multi-tenant) and the parent FK (nested routes) are folded into the same
    // WHERE so they stay authoritative and out-of-scope rows never leave the DB.
    if (prismaClient) {
      // Re-coerce filter values to the declared field type (e.g. ?sku=12345 on a
      // String column must reach Prisma as a string, not a number).
      const tq = toPrismaQuery(query)
      coercePrismaWhereTypes(tq.where, resource)

      // Deterministic order: keep the requested sorts, then an id:asc tiebreak so
      // cursor pagination is stable across requests (mirrors applySorts).
      const orderBy = (tq.orderBy as Array<Record<string, 'asc' | 'desc'>>).slice()
      if (!orderBy.some((o) => 'id' in o)) orderBy.push({ id: 'asc' })

      // Combine: scalar filters + M2M + search + parent FK + scope. Scope is
      // applied LAST so a client-supplied filter can never widen it.
      const fullWhere: Record<string, unknown> = { ...(prismaWhere ?? {}), ...tq.where }
      const searchWhere = buildPrismaSearchWhere(query.q, resource, spec.features)
      if (searchWhere) Object.assign(fullWhere, searchWhere)
      if (parent) fullWhere[parent.field] = parent.value
      if (ownership) fullWhere[ownership.column] = ownership.value

      // Real SQL COUNT for total — never a length of an in-memory array.
      const total = await resourceStore.count(fullWhere)
      const limit = query.pagination.limit

      const listOpts: ReadOptions = { where: fullWhere, orderBy }
      if (prismaInclude) listOpts.include = prismaInclude

      let pageItems: Array<Record<string, unknown>>
      let nextCursor: string | null = null
      let page: number

      if (query.pagination.cursor !== undefined && tq.cursor) {
        // Keyset: anchor on the cursor id, skip it, over-fetch one row so we know
        // whether another page exists without a second query.
        listOpts.cursor = tq.cursor
        listOpts.skip = 1
        listOpts.take = limit + 1
        const fetched = await resourceStore.list(listOpts)
        const hasMore = fetched.length > limit
        pageItems = hasMore ? fetched.slice(0, limit) : fetched
        const last = pageItems[pageItems.length - 1]
        nextCursor = hasMore && last ? String(last['id']) : null
        page = await computeCursorPage(resourceStore, fullWhere, query.sorts, tq.cursor.id, limit)
      } else if (query.pagination.page !== undefined) {
        // Offset pagination — exact page metadata via LIMIT/OFFSET.
        page = Math.max(1, query.pagination.page)
        listOpts.skip = (page - 1) * limit
        listOpts.take = limit
        pageItems = await resourceStore.list(listOpts)
      } else {
        // First page (legacy default) with a cursor-style nextCursor.
        listOpts.skip = 0
        listOpts.take = limit + 1
        const fetched = await resourceStore.list(listOpts)
        const hasMore = fetched.length > limit
        pageItems = hasMore ? fetched.slice(0, limit) : fetched
        const last = pageItems[pageItems.length - 1]
        nextCursor = hasMore && last ? String(last['id']) : null
        page = 1
      }

      const totalPages = limit > 0 ? Math.ceil(total / limit) : 0
      const pagination: PaginationMeta = {
        page, limit, total, totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      }

      // Relations are already nested by Prisma's native include; only the opt-in
      // aggregates remain (batched: one query per relation, never per row).
      if (aggregateIncludes.length > 0) {
        await applyAggregates(pageItems, resolveAggregates(resource, spec, aggregateIncludes), {
          store,
          prismaClient: prismaClient as unknown as PrismaAggregateClient,
        })
      }

      return c.json({
        data: pageItems,
        count: total,
        pagination,
        ...(nextCursor ? { nextCursor } : {}),
      })
    }

    // ── Memory mode: fetch all, then filter/sort/paginate in memory (unchanged) ─
    const listOpts: { include?: PrismaInclude; where?: Record<string, unknown> } = {}
    if (prismaInclude) listOpts.include = prismaInclude
    // Row-level scope (ownOnly / multi-tenant) + M2M filters → pushed to Prisma's
    // `where` so other tenants' rows never leave the database.
    const where: Record<string, unknown> = { ...(prismaWhere ?? {}) }
    if (prismaClient && ownership) where[ownership.column] = ownership.value
    if (Object.keys(where).length > 0) listOpts.where = where

    let items = await resourceStore.list(Object.keys(listOpts).length > 0 ? listOpts : undefined)
    if (parent) {
      items = items.filter((item) => item[parent.field] === parent.value)
    }

    // In-memory scope filter — authoritative in memory mode, redundant-but-safe
    // in Prisma mode (the where above already scoped the query).
    if (ownership) {
      items = items.filter((item) => item[ownership.column] === ownership.value)
    }

    const { data, count, nextCursor, pagination } = applyQuery(items, query, {
      resource,
      ...(spec.features ? { features: spec.features } : {}),
    })
    const identity = getRequesterIdentity(c)
    // Prisma already nested the relations; only the memory path needs applyIncludes.
    const enriched = prismaInclude
      ? data
      : await applyIncludes(
          data, relationIncludes, resource, spec, store,
          { userId: identity.userId },
          systemResolvers,
        )

    // Opt-in aggregates, batched (one query per relation, never per row).
    if (aggregateIncludes.length > 0) {
      await applyAggregates(enriched, resolveAggregates(resource, spec, aggregateIncludes), {
        store,
        ...(prismaClient ? { prismaClient: prismaClient as unknown as PrismaAggregateClient } : {}),
      })
    }

    return c.json({
      data: enriched,
      count,
      pagination,
      ...(nextCursor ? { nextCursor } : {}),
    })
  }

  const handleRead = async (c: Context, parent?: ParentScope): Promise<Response> => {
    const id = c.req.param('id') ?? ''

    // Validate `?include=` first so Prisma mode can fetch the row WITH its
    // relations natively (nested, any depth). Aggregate names are split out.
    const query = parseQueryParams(new URL(c.req.url))
    const { relationIncludes, aggregateIncludes } = partitionIncludes(resource, query.include)
    let prismaInclude: PrismaInclude | undefined
    if (relationIncludes.length > 0) {
      if (prismaClient) {
        const built = buildPrismaInclude(resource, spec, relationIncludes, getRequesterIdentity(c).userId)
        if (!built.ok) return c.json({ error: `Unknown relation: ${built.unknown}` }, 400)
        prismaInclude = built.include
      } else {
        const include = validateIncludes(relationIncludes, resource)
        if (!include.ok) return c.json({ error: `Unknown relation: ${include.unknown}` }, 400)
      }
    }

    const item = await resourceStore.get(id, prismaInclude ? { include: prismaInclude } : undefined)
    if (!item) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

    // Nested: hide cross-parent rows behind 404 (FK columns are present even
    // when relations are included).
    if (parent && item[parent.field] !== parent.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    // scope/ownOnly: hide out-of-scope rows behind 404 so existence isn't leaked.
    const ownership = getOwnershipFilter(c)
    if (ownership && item[ownership.column] !== ownership.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    const identity = getRequesterIdentity(c)
    let enriched: Record<string, unknown> = item
    if (!prismaInclude && relationIncludes.length > 0) {
      const results = await applyIncludes(
        [item], relationIncludes, resource, spec, store,
        { userId: identity.userId },
        systemResolvers,
      )
      enriched = results[0] ?? item
    }

    // Opt-in aggregates for the single row (one query per relation).
    if (aggregateIncludes.length > 0) {
      await applyAggregates([enriched], resolveAggregates(resource, spec, aggregateIncludes), {
        store,
        ...(prismaClient ? { prismaClient: prismaClient as unknown as PrismaAggregateClient } : {}),
      })
    }

    return c.json({ data: enriched })
  }

  const handleCreate = async (c: Context, parent?: ParentScope): Promise<Response> => {
    const read = await readBody(c, resource, uploadDir)
    if (!read.ok) return read.res

    // Nested: force FK from URL, overriding any client-supplied value.
    if (parent) read.data[parent.field] = parent.value

    // State machine: creation always starts at `initial` (a client cannot
    // create a row directly in a later state).
    if (sm) read.data[sm.field] = sm.initial

    // scope/ownOnly create: force the scope column to the requester's value, so
    // a member of org A cannot write into org B (even if the body says so).
    const ownership = getOwnershipFilter(c)
    if (ownership) {
      read.data[ownership.column] = ownership.value
    }

    // Nested + scope on the parent: when the FK column IS the scope column, the
    // URL must match the requester's scope (otherwise the requester would be
    // creating a row scoped to someone else through the URL).
    if (parent && ownership && parent.field === ownership.column && parent.value !== ownership.value) {
      return c.json({ error: 'Forbidden — cannot create resources outside your scope' }, 403)
    }

    // Extract nested manyToMany data before validation
    const { body: cleanBody, nested } = extractNestedRelations(read.data, resource)

    // beforeCreate hook — can throw to cancel, can mutate cleanBody
    if (resource.hooks?.beforeCreate) {
      try {
        await executeHook(resource.hooks.beforeCreate, handlers, cleanBody, c, store)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: 'Hook rejected request', details: message }, 400)
      }
    }

    // Validate primary fields only
    const fileFieldKeys = Object.entries(resource.fields)
      .filter(([, f]) => f.type === 'file')
      .map(([k]) => k)

    const schemaResult = schemas.create.safeParse(
      Object.fromEntries(
        Object.entries(cleanBody).filter(([k]) => !fileFieldKeys.includes(k))
      )
    )
    if (!schemaResult.success) return validationError(c, schemaResult.error.issues)

    // Transaction check
    const txConfig = resource.transactions?.find((t) => t.trigger === 'POST')
    if (txConfig) {
      const txResult = await runTransaction(txConfig.operations, cleanBody)
      if (!txResult.success) {
        return c.json(
          { error: 'Transaction failed', details: txResult.error, failedAt: txResult.failedOperation },
          409
        )
      }
    }

    // FK fields from manyToOne/oneToOne relations are not in Zod schema — re-attach them
    const fkFields = (resource.relations ?? [])
      .filter((r) => r.type === 'manyToOne' || r.type === 'oneToOne')
      .map((r) => r.field ?? `${r.resource.toLowerCase()}Id`)

    const id  = randomUUID()
    const now = new Date().toISOString()
    const item: Record<string, unknown> = {
      ...schemaResult.data,
      ...Object.fromEntries(fkFields.map((k) => [k, cleanBody[k]]).filter(([, v]) => v != null)),
      // Re-attach file URLs (already uploaded, not part of Zod schema)
      ...Object.fromEntries(fileFieldKeys.map((k) => [k, cleanBody[k]]).filter(([, v]) => v != null)),
      // scope/ownOnly: pin the scope column from the requester (the injected
      // userId isn't a Zod field; a scope column that IS a field is re-pinned
      // here too so the body can never override it).
      ...(ownership ? { [ownership.column]: ownership.value } : {}),
      // Server-managed fields applied last so a client-supplied id/createdAt/updatedAt
      // in the body cannot desync item.id from the store key.
      id, createdAt: now, updatedAt: now,
    }
    await resourceStore.create(id, item)

    // Persist nested M2M join records atomically — rollback the main record on failure.
    // Prisma mode writes the join rows to the DB; memory mode to the shared Map.
    if (nested.length > 0) {
      try {
        if (prismaClient) {
          await persistNestedRelationsPrisma(id, nested, resource, prismaClient)
        } else {
          persistNestedRelations(id, nested, resource, store)
        }
      } catch (err) {
        await resourceStore.delete(id)
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: 'Nested relation failed', details: message }, 409)
      }
    }

    // afterCreate hook — fire-and-forget (failure does not roll back)
    if (resource.hooks?.afterCreate) {
      try {
        await executeHook(resource.hooks.afterCreate, handlers, { ...item }, c, store)
      } catch { /* intentional: after-hooks do not cancel completed operations */ }
    }

    // Phase 3.3: outbound webhook — fire-and-forget; framework gates allowlist.
    if (emitWebhook) emitWebhook(`${lowerName}.created`, item)

    return c.json({ data: item }, 201)
  }

  const handleUpdate = async (c: Context, parent?: ParentScope): Promise<Response> => {
    const id = c.req.param('id') ?? ''
    const existing = await resourceStore.get(id)
    if (!existing) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

    if (parent && existing[parent.field] !== parent.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    // scope/ownOnly: editing an out-of-scope row reports 404, not 403.
    const ownership = getOwnershipFilter(c)
    if (ownership && existing[ownership.column] !== ownership.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    const read = await readBody(c, resource, uploadDir)
    if (!read.ok) return read.res

    const result = schemas.update.safeParse(read.data)
    if (!result.success) return validationError(c, result.error.issues)

    const updateData: Record<string, unknown> = { ...(result.data as Record<string, unknown>) }

    // State machine: when the update changes the state field, validate the
    // from→to transition and the requester's role. `from` is the PERSISTED
    // value (existing), `to` is the requested value.
    if (sm && updateData[sm.field] !== undefined) {
      const role = getRequesterIdentity(c).role
      const verdict = checkTransition(sm, existing[sm.field], updateData[sm.field], role)
      if (!verdict.ok) {
        return c.json({ error: verdict.message }, verdict.status)
      }
    }

    // beforeUpdate hook — can throw to cancel, can mutate updateData
    if (resource.hooks?.beforeUpdate) {
      try {
        await executeHook(resource.hooks.beforeUpdate, handlers, updateData, c, store)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: 'Hook rejected request', details: message }, 400)
      }
    }

    const txConfig = resource.transactions?.find((t) => t.trigger === 'PUT')
    if (txConfig) {
      const txResult = await runTransaction(txConfig.operations, read.data)
      if (!txResult.success) {
        return c.json(
          { error: 'Transaction failed', details: txResult.error, failedAt: txResult.failedOperation },
          409
        )
      }
    }

    const fkFieldsUpd = (resource.relations ?? [])
      .filter((r) => r.type === 'manyToOne' || r.type === 'oneToOne')
      .map((r) => r.field ?? `${r.resource.toLowerCase()}Id`)

    const updated: Record<string, unknown> = {
      ...existing,
      ...updateData,
      ...Object.fromEntries(fkFieldsUpd.map((k) => [k, read.data[k]]).filter(([, v]) => v != null)),
      // Server-managed fields applied last: id is pinned to the route param (the store key)
      // and updatedAt is set by the server, so a client-supplied value in the body is ignored.
      id,
      updatedAt: new Date().toISOString(),
      // scope/ownOnly: the scope column can never be transferred via PUT.
      ...(ownership && existing[ownership.column] != null ? { [ownership.column]: existing[ownership.column] } : {}),
      // Nested: parent FK is sticky — PUT cannot re-parent a child via body.
      ...(parent ? { [parent.field]: parent.value } : {}),
    }
    await resourceStore.update(id, updated)

    // afterUpdate hook — fire-and-forget
    if (resource.hooks?.afterUpdate) {
      try {
        await executeHook(resource.hooks.afterUpdate, handlers, { ...updated }, c, store)
      } catch { /* intentional */ }
    }

    if (emitWebhook) emitWebhook(`${lowerName}.updated`, updated)

    return c.json({ data: updated })
  }

  const handleDelete = async (c: Context, parent?: ParentScope): Promise<Response> => {
    const id = c.req.param('id') ?? ''
    const existing = await resourceStore.get(id)
    if (!existing) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

    if (parent && existing[parent.field] !== parent.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    // scope/ownOnly: deleting an out-of-scope row reports 404, not 403.
    const ownership = getOwnershipFilter(c)
    if (ownership && existing[ownership.column] !== ownership.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    // beforeDelete hook — can throw to cancel
    if (resource.hooks?.beforeDelete) {
      try {
        await executeHook(resource.hooks.beforeDelete, handlers, { id }, c, store)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: 'Hook rejected request', details: message }, 400)
      }
    }

    const txConfig = resource.transactions?.find((t) => t.trigger === 'DELETE')
    if (txConfig) {
      const txResult = await runTransaction(txConfig.operations, { id })
      if (!txResult.success) {
        return c.json(
          { error: 'Transaction failed', details: txResult.error, failedAt: txResult.failedOperation },
          409
        )
      }
    }

    await resourceStore.delete(id)

    // afterDelete hook — fire-and-forget
    if (resource.hooks?.afterDelete) {
      try {
        await executeHook(resource.hooks.afterDelete, handlers, { id }, c, store)
      } catch { /* intentional */ }
    }

    if (emitWebhook) emitWebhook(`${lowerName}.deleted`, { id, ...existing })

    return c.json({ data: null })
  }

  return { guards, hasOwnOnly, handleList, handleRead, handleCreate, handleUpdate, handleDelete }
}

/**
 * Collects "(parent, child, fk)" tuples for which nested routes should be
 * generated. A pair is produced whenever the child resource declares a
 * manyToOne/oneToOne back to a parent, or the parent declares a oneToMany
 * pointing at the child. Each pair is emitted at most once.
 */
function collectNestedRelations(
  spec: ZeroAPISpec,
): Array<{ parent: ResourceDefinition; child: ResourceDefinition; fkField: string }> {
  const out: Array<{ parent: ResourceDefinition; child: ResourceDefinition; fkField: string }> = []
  const seen = new Set<string>()

  // Driven by the FK side (manyToOne / oneToOne).
  for (const child of spec.resources) {
    for (const rel of child.relations ?? []) {
      if (rel.type !== 'manyToOne' && rel.type !== 'oneToOne') continue
      const parent = spec.resources.find((r) => r.name === rel.resource)
      if (!parent) continue
      const fkField = rel.field ?? `${parent.name.toLowerCase()}Id`
      const key = `${parent.name}->${child.name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ parent, child, fkField })
    }
  }

  // Driven by the oneToMany side without a reverse manyToOne — fall back to
  // the conventional FK on the child.
  for (const parent of spec.resources) {
    for (const rel of parent.relations ?? []) {
      if (rel.type !== 'oneToMany') continue
      const child = spec.resources.find((r) => r.name === rel.resource)
      if (!child) continue
      const key = `${parent.name}->${child.name}`
      if (seen.has(key)) continue
      const reverse = child.relations?.find(
        (r) => r.resource === parent.name && (r.type === 'manyToOne' || r.type === 'oneToOne'),
      )
      const fkField = reverse?.field ?? `${parent.name.toLowerCase()}Id`
      seen.add(key)
      out.push({ parent, child, fkField })
    }
  }

  return out
}

function registerResource(
  resource: ResourceDefinition,
  store: DataStore,
  provider: ResourceStoreProvider,
  spec: ZeroAPISpec,
  authMiddleware?: MiddlewareHandler,
  uploadDir?: string,
  handlers: Record<string, HandlerFn> = {},
  emitWebhook?: EmitWebhookFn,
  systemResolvers?: SystemResourceResolvers,
): { router: Hono; bundle: ResourceHandlerBundle } {
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const bundle = buildResourceHandlerBundle(
    resource, store, provider, spec, authMiddleware, uploadDir, handlers, emitWebhook, systemResolvers,
  )
  const router = new Hono()

  // LIST — filtering, sorting, cursor pagination, includes
  if (endpoints.includes('list')) {
    mount(router, 'get', '/', bundle.guards.list, (c) => bundle.handleList(c))
  }

  // CUSTOM ENDPOINTS — registered before /:id to take priority in RegExpRouter
  for (const endpoint of resource.customEndpoints ?? []) {
    const method = endpoint.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch'
    const guard = buildCustomGuard(endpoint, spec, authMiddleware)
    mount(router, method, endpoint.path, guard, async (c) => {
      const fn = handlers[endpoint.handler]
      if (!fn) return c.json({ error: `Handler "${endpoint.handler}" not registered` }, 501)

      let input: Record<string, unknown> = {}
      try {
        if (method !== 'get' && method !== 'delete') {
          input = await c.req.json() as Record<string, unknown>
        }
      } catch { /* GET/DELETE have no body — ignore parse errors */ }

      try {
        const result = await fn({ input, ctx: c, store, services: {} })
        if (result instanceof Response) return result
        return c.json({ data: result ?? null })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 400)
      }
    })
  }

  // CREATE
  if (endpoints.includes('create')) {
    mount(router, 'post', '/', bundle.guards.create, (c) => bundle.handleCreate(c))
  }

  // READ
  if (endpoints.includes('read')) {
    mount(router, 'get', '/:id', bundle.guards.read, (c) => bundle.handleRead(c))
  }

  // UPDATE
  if (endpoints.includes('update')) {
    mount(router, 'put', '/:id', bundle.guards.update, (c) => bundle.handleUpdate(c))
  }

  // DELETE
  if (endpoints.includes('delete')) {
    mount(router, 'delete', '/:id', bundle.guards.delete, (c) => bundle.handleDelete(c))
  }

  return { router, bundle }
}

/**
 * Phase 2.1: mount nested routes `/<parent>/:parentId/<child>[/...]` on the
 * parent's router. Re-uses the child's handler bundle so RBAC, hooks,
 * transactions, validation, and includes all behave like the flat endpoints.
 */
function registerNestedRoutes(
  parentRouter: Hono,
  parent: ResourceDefinition,
  child: ResourceDefinition,
  fkField: string,
  provider: ResourceStoreProvider,
  childBundle: ResourceHandlerBundle,
): void {
  const childEndpoints = child.endpoints ?? DEFAULT_ENDPOINTS
  const basePath = `/:parentId/${toPlural(child.name)}`
  // Parent existence is checked against the resolved backend — the DB in Prisma
  // mode (findUnique), the shared Map in memory mode (P0-2). Previously this read
  // only the Map, so every nested route 404'd in Prisma mode.
  const parentStore = provider.for(parent.name)

  const requireParent = async (c: Context): Promise<Response | null> => {
    const parentId = c.req.param('parentId') ?? ''
    const found = await parentStore.get(parentId)
    if (!found) {
      return c.json({ error: `${parent.name} with id "${parentId}" not found` }, 404)
    }
    return null
  }

  const scope = (c: Context): ParentScope => ({
    field: fkField,
    value: c.req.param('parentId') ?? '',
  })

  if (childEndpoints.includes('list')) {
    mount(parentRouter, 'get', basePath, childBundle.guards.list, async (c) => {
      const miss = await requireParent(c); if (miss) return miss
      return childBundle.handleList(c, scope(c))
    })
  }

  if (childEndpoints.includes('create')) {
    mount(parentRouter, 'post', basePath, childBundle.guards.create, async (c) => {
      const miss = await requireParent(c); if (miss) return miss
      return childBundle.handleCreate(c, scope(c))
    })
  }

  if (childEndpoints.includes('read')) {
    mount(parentRouter, 'get', `${basePath}/:id`, childBundle.guards.read, async (c) => {
      const miss = await requireParent(c); if (miss) return miss
      return childBundle.handleRead(c, scope(c))
    })
  }
}

/**
 * Registers all resource routes on the Hono app.
 * Integrates: auth guards, RBAC, query builder, includes, transactions, file uploads,
 * lifecycle hooks, custom endpoints, and (Phase 2.1) nested relation endpoints.
 */
export function generateRoutes(
  spec: ZeroAPISpec,
  app: Hono,
  store: DataStore,
  authMiddleware?: MiddlewareHandler,
  uploadDir?: string,
  handlers: Record<string, HandlerFn> = {},
  emitWebhook?: EmitWebhookFn,
  systemResolvers?: SystemResourceResolvers,
  resourceStore?: ResourceStoreProvider,
): void {
  // Resolve the persistence backend. When no provider is supplied (e.g. direct
  // callers / older call sites) we default to an in-memory provider over the
  // same `store` map — byte-for-byte the historical behaviour.
  const provider: ResourceStoreProvider = resourceStore ?? new MemoryResourceStoreProvider(store)

  // First pass: build flat routes for every resource and remember the bundles
  // so the second pass can mount nested routes on the parent's router.
  const built = new Map<string, { router: Hono; bundle: ResourceHandlerBundle }>()
  for (const resource of spec.resources) {
    built.set(
      resource.name,
      registerResource(resource, store, provider, spec, authMiddleware, uploadDir, handlers, emitWebhook, systemResolvers),
    )
  }

  // Second pass: nested routes — wired before app.route so they share the
  // parent's mount path and Hono's regex router treats them as siblings of
  // the flat /:id route (with longer, more specific patterns winning).
  // System resources (e.g. User when auth.jwt is on) are never in spec.resources,
  // so collectNestedRelations naturally skips them via its `spec.resources.find`.
  for (const { parent, child, fkField } of collectNestedRelations(spec)) {
    const parentEntry = built.get(parent.name)
    const childEntry  = built.get(child.name)
    if (!parentEntry || !childEntry) continue
    registerNestedRoutes(parentEntry.router, parent, child, fkField, provider, childEntry.bundle)
  }

  for (const resource of spec.resources) {
    const entry = built.get(resource.name)
    if (!entry) continue
    app.route(`/${toPlural(resource.name)}`, entry.router)
  }
}
