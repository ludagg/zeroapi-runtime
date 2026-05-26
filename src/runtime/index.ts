import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { ZeroAPISpec } from '../types/spec.js'
import type { ResourceSchemas } from '../generators/validation.js'
import type { DataStore } from '../generators/routes.js'
import { generateRoutes } from '../generators/routes.js'
import { generatePrismaSchema } from '../generators/schema.js'
import { generateZodSchemas } from '../generators/validation.js'
import { generateTests } from '../generators/tests.js'
import { createAuthMiddleware } from '../auth/middleware.js'

export interface RuntimeOptions {
  /** Enable HTTP request logging. Defaults to true. */
  enableLogging?: boolean
  /** Enable CORS middleware. Defaults to true. */
  enableCors?: boolean
}

export interface RuntimeResult {
  /** Hono application with all resource routes registered and ready to serve. */
  app: Hono
  /** Generated Prisma schema string — write to prisma/schema.prisma. */
  prismaSchema: string
  /** Generated Zod schemas indexed by resource name. */
  zodSchemas: Record<string, ResourceSchemas>
  /** Generated Vitest test suite as a string — write to tests/generated.test.ts. */
  testSuite: string
  /** The spec that was used to build this runtime. */
  spec: ZeroAPISpec
}

/**
 * Core runtime factory. Consumes a validated ZeroAPISpec and produces a complete,
 * runnable Hono application along with generated artifacts (Prisma schema, Zod schemas, tests).
 *
 * The in-memory data store is suitable for development and testing.
 * In production, replace route handlers with Prisma-backed implementations.
 */
export function createRuntime(spec: ZeroAPISpec, options: RuntimeOptions = {}): RuntimeResult {
  const { enableLogging = true, enableCors = true } = options

  const app = new Hono()
  const store: DataStore = new Map()

  if (enableCors) {
    app.use('*', cors())
  }
  if (enableLogging) {
    app.use('*', logger())
  }

  app.get('/health', (c) =>
    c.json({ status: 'ok', name: spec.name, version: spec.version })
  )

  const authMiddleware = spec.auth ? createAuthMiddleware(spec.auth) : undefined

  generateRoutes(spec, app, store, authMiddleware)

  const zodSchemas: Record<string, ResourceSchemas> = {}
  for (const resource of spec.resources) {
    zodSchemas[resource.name] = generateZodSchemas(resource)
  }

  return {
    app,
    prismaSchema: generatePrismaSchema(spec),
    zodSchemas,
    testSuite: generateTests(spec),
    spec,
  }
}
