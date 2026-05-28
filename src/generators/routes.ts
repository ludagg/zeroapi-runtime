import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type { ZeroAPISpec, ResourceDefinition, CrudAction, CustomEndpointDef } from '../types/spec.js'
import type { DataStore, ResourceStore } from '../types/store.js'
import type { HandlerFn } from '../hooks/types.js'
import { generateZodSchemas } from './validation.js'
import { createPermissionMiddleware } from '../rbac/permissions.js'
import { parseQueryParams } from '../query/builder.js'
import { applyQuery } from '../query/apply.js'
import { applyIncludes, extractNestedRelations, persistNestedRelations } from '../relations/index.js'
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

function buildGuard(
  resource: ResourceDefinition,
  action: 'read' | 'write' | 'delete',
  spec: ZeroAPISpec,
  globalAuth?: MiddlewareHandler
): MiddlewareHandler | null {
  const guards: MiddlewareHandler[] = []
  if (resource.auth?.required && globalAuth) guards.push(globalAuth)
  const allowed = resource.rbac?.[action]
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

function registerResource(
  app: Hono,
  resource: ResourceDefinition,
  store: DataStore,
  spec: ZeroAPISpec,
  authMiddleware?: MiddlewareHandler,
  uploadDir?: string,
  handlers: Record<string, HandlerFn> = {}
): void {
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const schemas   = generateZodSchemas(resource)
  const key       = resource.name.toLowerCase()
  const routePath = `/${toPlural(resource.name)}`

  if (!store.has(key)) store.set(key, new Map())
  const getStore = (): ResourceStore => store.get(key) as ResourceStore

  const readGuard   = buildGuard(resource, 'read',   spec, authMiddleware)
  const writeGuard  = buildGuard(resource, 'write',  spec, authMiddleware)
  const deleteGuard = buildGuard(resource, 'delete', spec, authMiddleware)

  const router = new Hono()

  // LIST — filtering, sorting, cursor pagination, includes
  if (endpoints.includes('list')) {
    mount(router, 'get', '/', readGuard, (c) => {
      const query = parseQueryParams(new URL(c.req.url))
      const allItems = Array.from(getStore().values())
      const { data, count, nextCursor } = applyQuery(allItems, query)
      const enriched = applyIncludes(data, query.include, resource, spec, store)
      return c.json({ data: enriched, count, ...(nextCursor ? { nextCursor } : {}) })
    })
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

  // CREATE — file upload, nested relations, transactions, hooks
  if (endpoints.includes('create')) {
    mount(router, 'post', '/', writeGuard, async (c) => {
      const read = await readBody(c, resource, uploadDir)
      if (!read.ok) return read.res

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
    })
  }

  // READ — with optional ?include=
  if (endpoints.includes('read')) {
    mount(router, 'get', '/:id', readGuard, (c) => {
      const id = c.req.param('id') ?? ''
      const item = getStore().get(id)
      if (!item) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

      const query = parseQueryParams(new URL(c.req.url))
      const enriched = query.include.length > 0
        ? applyIncludes([item], query.include, resource, spec, store)[0] ?? item
        : item

      return c.json({ data: enriched })
    })
  }

  // UPDATE — file upload, transactions, hooks
  if (endpoints.includes('update')) {
    mount(router, 'put', '/:id', writeGuard, async (c) => {
      const id = c.req.param('id') ?? ''
      const existing = getStore().get(id)
      if (!existing) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

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
      }
      getStore().set(id, updated)

      // afterUpdate hook — fire-and-forget
      if (resource.hooks?.afterUpdate) {
        try {
          await executeHook(resource.hooks.afterUpdate, handlers, { ...updated }, c, store)
        } catch { /* intentional */ }
      }

      return c.json({ data: updated })
    })
  }

  // DELETE — transactions, hooks
  if (endpoints.includes('delete')) {
    mount(router, 'delete', '/:id', deleteGuard, async (c) => {
      const id = c.req.param('id') ?? ''
      if (!getStore().has(id)) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

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
    })
  }

  app.route(routePath, router)
}

/**
 * Registers all resource routes on the Hono app.
 * Integrates: auth guards, RBAC, query builder, includes, transactions, file uploads,
 * lifecycle hooks, and custom endpoints.
 */
export function generateRoutes(
  spec: ZeroAPISpec,
  app: Hono,
  store: DataStore,
  authMiddleware?: MiddlewareHandler,
  uploadDir?: string,
  handlers: Record<string, HandlerFn> = {}
): void {
  for (const resource of spec.resources) {
    registerResource(app, resource, store, spec, authMiddleware, uploadDir, handlers)
  }
}
