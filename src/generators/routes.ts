import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import type { MiddlewareHandler } from 'hono'
import type { ZeroAPISpec, ResourceDefinition, CrudAction } from '../types/spec.js'
import { generateZodSchemas } from './validation.js'

export type ResourceStore = Map<string, Record<string, unknown>>
export type DataStore = Map<string, ResourceStore>

const DEFAULT_ENDPOINTS: CrudAction[] = ['list', 'create', 'read', 'update', 'delete']

function toPlural(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('s')) return lower
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies'
  return lower + 's'
}

function registerResource(
  app: Hono,
  resource: ResourceDefinition,
  store: DataStore,
  authMiddleware?: MiddlewareHandler
): void {
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const schemas = generateZodSchemas(resource)
  const resourceKey = resource.name.toLowerCase()
  const routePath = `/${toPlural(resource.name)}`

  if (!store.has(resourceKey)) {
    store.set(resourceKey, new Map())
  }

  const router = new Hono()

  if (resource.auth?.required && authMiddleware) {
    router.use('*', authMiddleware)
  }

  if (endpoints.includes('list')) {
    router.get('/', (c) => {
      const items = Array.from((store.get(resourceKey) as ResourceStore).values())
      return c.json({ data: items, count: items.length })
    })
  }

  if (endpoints.includes('create')) {
    router.post('/', async (c) => {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Request body must be valid JSON' }, 400)
      }

      const parsed = schemas.create.safeParse(body)
      if (!parsed.success) {
        return c.json(
          {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          },
          422
        )
      }

      const id = randomUUID()
      const now = new Date().toISOString()
      const item: Record<string, unknown> = { id, createdAt: now, updatedAt: now, ...parsed.data }
      ;(store.get(resourceKey) as ResourceStore).set(id, item)
      return c.json({ data: item }, 201)
    })
  }

  if (endpoints.includes('read')) {
    router.get('/:id', (c) => {
      const id = c.req.param('id')
      const item = (store.get(resourceKey) as ResourceStore).get(id)
      if (!item) {
        return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
      }
      return c.json({ data: item })
    })
  }

  if (endpoints.includes('update')) {
    router.put('/:id', async (c) => {
      const id = c.req.param('id')
      const existing = (store.get(resourceKey) as ResourceStore).get(id)
      if (!existing) {
        return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
      }

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Request body must be valid JSON' }, 400)
      }

      const parsed = schemas.update.safeParse(body)
      if (!parsed.success) {
        return c.json(
          {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          },
          422
        )
      }

      const updated: Record<string, unknown> = {
        ...existing,
        ...(parsed.data as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      }
      ;(store.get(resourceKey) as ResourceStore).set(id, updated)
      return c.json({ data: updated })
    })
  }

  if (endpoints.includes('delete')) {
    router.delete('/:id', (c) => {
      const id = c.req.param('id')
      const exists = (store.get(resourceKey) as ResourceStore).has(id)
      if (!exists) {
        return c.json({ error: `${resource.name} with id "${id}" not found` }, 404)
      }
      ;(store.get(resourceKey) as ResourceStore).delete(id)
      return c.json({ data: null })
    })
  }

  app.route(routePath, router)
}

/**
 * Registers all resource routes on the provided Hono app instance.
 * Routes follow REST conventions: GET /resources, POST /resources, GET /resources/:id, etc.
 */
export function generateRoutes(
  spec: ZeroAPISpec,
  app: Hono,
  store: DataStore,
  authMiddleware?: MiddlewareHandler
): void {
  for (const resource of spec.resources) {
    registerResource(app, resource, store, authMiddleware)
  }
}
