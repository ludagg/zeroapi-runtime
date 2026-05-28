import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type {
  ZeroAPISpec, ResourceDefinition, CrudAction, CustomEndpointDef, PermissionAction,
} from '../types/spec.js'
import type { DataStore, ResourceStore } from '../types/store.js'
import type { HandlerFn } from '../hooks/types.js'
import { generateZodSchemas, type ResourceSchemas } from './validation.js'
import { createPermissionMiddleware } from '../rbac/permissions.js'
import {
  buildResourcePermissionGuard,
  getOwnershipFilter,
  getRequesterIdentity,
  resourceHasOwnOnly,
} from '../rbac/resource-permissions.js'
import { parseQueryParams } from '../query/builder.js'
import { applyQuery } from '../query/apply.js'
import {
  applyIncludes, extractNestedRelations, persistNestedRelations, validateIncludes,
} from '../relations/index.js'
import { executeTransaction } from '../transactions/executor.js'
import { processFileFields } from '../upload/index.js'
import { toPlural } from '../utils/plural.js'
import { executeHook } from '../hooks/runner.js'

export type { DataStore, ResourceStore }

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
  spec: ZeroAPISpec,
  authMiddleware?: MiddlewareHandler,
  uploadDir?: string,
  handlers: Record<string, HandlerFn> = {},
): ResourceHandlerBundle {
  const key = resource.name.toLowerCase()
  if (!store.has(key)) store.set(key, new Map())
  const getStore = (): ResourceStore => store.get(key) as ResourceStore

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

  const handleList = (c: Context, parent?: ParentScope): Response => {
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

    const include = validateIncludes(query.include, resource)
    if (!include.ok) {
      return c.json({ error: `Unknown relation: ${include.unknown}` }, 400)
    }

    let items = Array.from(getStore().values())
    if (parent) {
      items = items.filter((item) => item[parent.field] === parent.value)
    }

    const ownership = getOwnershipFilter(c)
    if (ownership) {
      items = items.filter((item) => item['userId'] === ownership.userId)
    }

    const { data, count, nextCursor, pagination } = applyQuery(items, query, {
      resource,
      ...(spec.features ? { features: spec.features } : {}),
    })
    const identity = getRequesterIdentity(c)
    const enriched = applyIncludes(data, query.include, resource, spec, store, { userId: identity.userId })
    return c.json({
      data: enriched,
      count,
      pagination,
      ...(nextCursor ? { nextCursor } : {}),
    })
  }

  const handleRead = (c: Context, parent?: ParentScope): Response => {
    const id = c.req.param('id') ?? ''
    const item = getStore().get(id)
    if (!item) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

    // Nested: hide cross-parent rows behind 404
    if (parent && item[parent.field] !== parent.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    // ownOnly: hide non-owned rows behind 404 so existence is not leaked.
    const ownership = getOwnershipFilter(c)
    if (ownership && item['userId'] !== ownership.userId) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    const query = parseQueryParams(new URL(c.req.url))
    const include = validateIncludes(query.include, resource)
    if (!include.ok) {
      return c.json({ error: `Unknown relation: ${include.unknown}` }, 400)
    }

    const identity = getRequesterIdentity(c)
    const enriched = query.include.length > 0
      ? applyIncludes([item], query.include, resource, spec, store, { userId: identity.userId })[0] ?? item
      : item

    return c.json({ data: enriched })
  }

  const handleCreate = async (c: Context, parent?: ParentScope): Promise<Response> => {
    const read = await readBody(c, resource, uploadDir)
    if (!read.ok) return read.res

    // Nested: force FK from URL, overriding any client-supplied value.
    if (parent) read.data[parent.field] = parent.value

    // ownOnly create: requester owns the new row.
    const ownership = getOwnershipFilter(c)
    if (ownership) {
      read.data['userId'] = ownership.userId
    }

    // Nested + ownOnly on the parent: when the FK column is the user id itself,
    // the URL must match the authenticated identity (otherwise the requester
    // would be creating a row "owned" by someone else through the URL).
    if (parent && parent.field === 'userId' && ownership && parent.value !== ownership.userId) {
      return c.json({ error: 'Forbidden — cannot create resources for another user' }, 403)
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
      const txResult = await executeTransaction(txConfig.operations, cleanBody, store)
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
      // ownOnly: pin userId from the authenticated identity (not part of Zod schema).
      ...(hasOwnOnly && cleanBody['userId'] != null ? { userId: cleanBody['userId'] } : {}),
      // Server-managed fields applied last so a client-supplied id/createdAt/updatedAt
      // in the body cannot desync item.id from the store key.
      id, createdAt: now, updatedAt: now,
    }
    getStore().set(id, item)

    // Persist nested M2M join records atomically — rollback the main record on failure
    if (nested.length > 0) {
      try {
        persistNestedRelations(id, nested, resource, store)
      } catch (err) {
        getStore().delete(id)
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

    return c.json({ data: item }, 201)
  }

  const handleUpdate = async (c: Context, parent?: ParentScope): Promise<Response> => {
    const id = c.req.param('id') ?? ''
    const existing = getStore().get(id)
    if (!existing) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

    if (parent && existing[parent.field] !== parent.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    // ownOnly: editing someone else's row reports 404, not 403.
    const ownership = getOwnershipFilter(c)
    if (ownership && existing['userId'] !== ownership.userId) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    const read = await readBody(c, resource, uploadDir)
    if (!read.ok) return read.res

    const result = schemas.update.safeParse(read.data)
    if (!result.success) return validationError(c, result.error.issues)

    const updateData: Record<string, unknown> = { ...(result.data as Record<string, unknown>) }

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
      const txResult = await executeTransaction(txConfig.operations, read.data, store)
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
      // ownOnly: ownership can never be transferred via PUT.
      ...(hasOwnOnly && existing['userId'] != null ? { userId: existing['userId'] } : {}),
      // Nested: parent FK is sticky — PUT cannot re-parent a child via body.
      ...(parent ? { [parent.field]: parent.value } : {}),
    }
    getStore().set(id, updated)

    // afterUpdate hook — fire-and-forget
    if (resource.hooks?.afterUpdate) {
      try {
        await executeHook(resource.hooks.afterUpdate, handlers, { ...updated }, c, store)
      } catch { /* intentional */ }
    }

    return c.json({ data: updated })
  }

  const handleDelete = async (c: Context, parent?: ParentScope): Promise<Response> => {
    const id = c.req.param('id') ?? ''
    const existing = getStore().get(id)
    if (!existing) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

    if (parent && existing[parent.field] !== parent.value) {
      return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
    }

    // ownOnly: deleting someone else's row reports 404, not 403.
    const ownership = getOwnershipFilter(c)
    if (ownership && existing['userId'] !== ownership.userId) {
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
      const txResult = await executeTransaction(txConfig.operations, { id }, store)
      if (!txResult.success) {
        return c.json(
          { error: 'Transaction failed', details: txResult.error, failedAt: txResult.failedOperation },
          409
        )
      }
    }

    getStore().delete(id)

    // afterDelete hook — fire-and-forget
    if (resource.hooks?.afterDelete) {
      try {
        await executeHook(resource.hooks.afterDelete, handlers, { id }, c, store)
      } catch { /* intentional */ }
    }

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
  spec: ZeroAPISpec,
  authMiddleware?: MiddlewareHandler,
  uploadDir?: string,
  handlers: Record<string, HandlerFn> = {}
): { router: Hono; bundle: ResourceHandlerBundle } {
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const bundle = buildResourceHandlerBundle(resource, store, spec, authMiddleware, uploadDir, handlers)
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
  store: DataStore,
  childBundle: ResourceHandlerBundle,
): void {
  const parentKey = parent.name.toLowerCase()
  const childEndpoints = child.endpoints ?? DEFAULT_ENDPOINTS
  const basePath = `/:parentId/${toPlural(child.name)}`

  const requireParent = (c: Context): Response | null => {
    const parentId = c.req.param('parentId') ?? ''
    if (!store.get(parentKey)?.has(parentId)) {
      return c.json({ error: `${parent.name} with id "${parentId}" not found` }, 404)
    }
    return null
  }

  const scope = (c: Context): ParentScope => ({
    field: fkField,
    value: c.req.param('parentId') ?? '',
  })

  if (childEndpoints.includes('list')) {
    mount(parentRouter, 'get', basePath, childBundle.guards.list, (c) => {
      const miss = requireParent(c); if (miss) return miss
      return childBundle.handleList(c, scope(c))
    })
  }

  if (childEndpoints.includes('create')) {
    mount(parentRouter, 'post', basePath, childBundle.guards.create, async (c) => {
      const miss = requireParent(c); if (miss) return miss
      return childBundle.handleCreate(c, scope(c))
    })
  }

  if (childEndpoints.includes('read')) {
    mount(parentRouter, 'get', `${basePath}/:id`, childBundle.guards.read, (c) => {
      const miss = requireParent(c); if (miss) return miss
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
  handlers: Record<string, HandlerFn> = {}
): void {
  // First pass: build flat routes for every resource and remember the bundles
  // so the second pass can mount nested routes on the parent's router.
  const built = new Map<string, { router: Hono; bundle: ResourceHandlerBundle }>()
  for (const resource of spec.resources) {
    built.set(
      resource.name,
      registerResource(resource, store, spec, authMiddleware, uploadDir, handlers),
    )
  }

  // Second pass: nested routes — wired before app.route so they share the
  // parent's mount path and Hono's regex router treats them as siblings of
  // the flat /:id route (with longer, more specific patterns winning).
  for (const { parent, child, fkField } of collectNestedRelations(spec)) {
    const parentEntry = built.get(parent.name)
    const childEntry  = built.get(child.name)
    if (!parentEntry || !childEntry) continue
    registerNestedRoutes(parentEntry.router, parent, child, fkField, store, childEntry.bundle)
  }

  for (const resource of spec.resources) {
    const entry = built.get(resource.name)
    if (!entry) continue
    app.route(`/${toPlural(resource.name)}`, entry.router)
  }
}
