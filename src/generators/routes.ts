import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import type { Context, MiddlewareHandler } from 'hono'
import type { ZeroAPISpec, ResourceDefinition, CrudAction } from '../types/spec.js'
import { generateZodSchemas } from './validation.js'
import { createPermissionMiddleware } from '../rbac/permissions.js'

export type ResourceStore = Map<string, Record<string, unknown>>
export type DataStore = Map<string, ResourceStore>

const DEFAULT_ENDPOINTS: CrudAction[] = ['list', 'create', 'read', 'update', 'delete']

function toPlural(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('s')) return lower
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies'
  return lower + 's'
}

/**
 * Composes multiple middleware handlers into a single MiddlewareHandler.
 * Returns null when the list is empty (no guard needed).
 */
function composeGuard(guards: MiddlewareHandler[]): MiddlewareHandler | null {
  if (guards.length === 0) return null
  if (guards.length === 1) return guards[0] ?? null

  return async (c, next) => {
    let i = 0
    const dispatch = async (): Promise<void> => {
      if (i >= guards.length) {
        await next()
        return
      }
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

  if (resource.auth?.required && globalAuth) {
    guards.push(globalAuth)
  }

  const allowedRoles = resource.rbac?.[action]
  if (allowedRoles && allowedRoles.length > 0) {
    guards.push(createPermissionMiddleware(allowedRoles, spec))
  }

  return composeGuard(guards)
}

type RouteHandler = (c: Context) => Response | Promise<Response>

function mount(
  router: Hono,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  guard: MiddlewareHandler | null,
  handler: RouteHandler
): void {
  if (guard) {
    router[method](path, guard, handler)
  } else {
    router[method](path, handler)
  }
}

function validationError(
  c: Context,
  issues: Array<{ path: (string | number)[]; message: string }>
): Response {
  return c.json(
    {
      error: 'Validation failed',
      details: issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    },
    422
  )
}

function registerResource(
  app: Hono,
  resource: ResourceDefinition,
  store: DataStore,
  spec: ZeroAPISpec,
  authMiddleware?: MiddlewareHandler
): void {
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const schemas = generateZodSchemas(resource)
  const key = resource.name.toLowerCase()
  const routePath = `/${toPlural(resource.name)}`

  if (!store.has(key)) store.set(key, new Map())

  const router = new Hono()
  const getStore = (): ResourceStore => store.get(key) as ResourceStore

  const readGuard   = buildGuard(resource, 'read',   spec, authMiddleware)
  const writeGuard  = buildGuard(resource, 'write',  spec, authMiddleware)
  const deleteGuard = buildGuard(resource, 'delete', spec, authMiddleware)

  // LIST
  if (endpoints.includes('list')) {
    mount(router, 'get', '/', readGuard, (c) => {
      const items = Array.from(getStore().values())
      return c.json({ data: items, count: items.length })
    })
  }

  // CREATE
  if (endpoints.includes('create')) {
    mount(router, 'post', '/', writeGuard, async (c) => {
      let body: unknown
      try { body = await c.req.json() }
      catch { return c.json({ error: 'Request body must be valid JSON' }, 400) }

      const result = schemas.create.safeParse(body)
      if (!result.success) return validationError(c, result.error.issues)

      const id = randomUUID()
      const now = new Date().toISOString()
      const item: Record<string, unknown> = { id, createdAt: now, updatedAt: now, ...result.data }
      getStore().set(id, item)
      return c.json({ data: item }, 201)
    })
  }

  // READ
  if (endpoints.includes('read')) {
    mount(router, 'get', '/:id', readGuard, (c) => {
      const id = c.req.param('id') ?? ''
      const item = getStore().get(id)
      if (!item) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
      return c.json({ data: item })
    })
  }

  // UPDATE
  if (endpoints.includes('update')) {
    mount(router, 'put', '/:id', writeGuard, async (c) => {
      const id = c.req.param('id') ?? ''
      const existing = getStore().get(id)
      if (!existing) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)

      let body: unknown
      try { body = await c.req.json() }
      catch { return c.json({ error: 'Request body must be valid JSON' }, 400) }

      const result = schemas.update.safeParse(body)
      if (!result.success) return validationError(c, result.error.issues)

      const updated: Record<string, unknown> = {
        ...existing,
        ...(result.data as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      }
      getStore().set(id, updated)
      return c.json({ data: updated })
    })
  }

  // DELETE
  if (endpoints.includes('delete')) {
    mount(router, 'delete', '/:id', deleteGuard, (c) => {
      const id = c.req.param('id') ?? ''
      if (!getStore().has(id)) return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
      getStore().delete(id)
      return c.json({ data: null })
    })
  }

  app.route(routePath, router)
}

/**
 * Registers all resource routes on the Hono app.
 * Applies auth middleware and RBAC permission checks per action when configured in the spec.
 */
export function generateRoutes(
  spec: ZeroAPISpec,
  app: Hono,
  store: DataStore,
  authMiddleware?: MiddlewareHandler
): void {
  for (const resource of spec.resources) {
    registerResource(app, resource, store, spec, authMiddleware)
  }
}
