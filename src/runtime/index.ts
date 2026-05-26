import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { ZeroAPISpec } from '../types/spec.js'
import type { ResourceSchemas } from '../generators/validation.js'
import type { DataStore } from '../generators/routes.js'
import type { OpenAPISpec } from '../docs/swagger.js'
import { generateRoutes } from '../generators/routes.js'
import { generatePrismaSchema } from '../generators/schema.js'
import { generateZodSchemas } from '../generators/validation.js'
import { generateTests } from '../generators/tests.js'
import { createAuthMiddleware } from '../auth/middleware.js'
import { createHelmetMiddleware } from '../security/helmet.js'
import { createCorsMiddleware } from '../security/cors.js'
import { createRateLimitMiddleware } from '../security/ratelimit.js'
import { createSanitizeMiddleware } from '../security/sanitize.js'
import { generateOpenAPISpec } from '../docs/swagger.js'
import { mountScalarDocs } from '../docs/scalar.js'

export interface RuntimeOptions {
  enableLogging?: boolean
  enableCors?: boolean
  enableHelmet?: boolean
  enableSanitize?: boolean
  enableDocs?: boolean
  /** Directory for local file uploads. Defaults to "./uploads". */
  uploadDir?: string
}

export interface RuntimeResult {
  app: Hono
  prismaSchema: string
  zodSchemas: Record<string, ResourceSchemas>
  testSuite: string
  openApiSpec: OpenAPISpec
  spec: ZeroAPISpec
}

/**
 * Core runtime factory.
 *
 * Wires together:
 *  - Security headers · CORS · rate limiting · sanitisation
 *  - JWT / API-key authentication
 *  - RBAC permission checks per resource action
 *  - REST routes with filtering, sorting, cursor pagination, ?include=
 *  - Relation support (manyToOne/oneToMany/manyToMany with nested creation)
 *  - Atomic transactions with rollback
 *  - File upload (local / S3 / R2) with MIME + size validation
 *  - OpenAPI 3.0 JSON + Scalar docs UI
 */
export function createRuntime(spec: ZeroAPISpec, options: RuntimeOptions = {}): RuntimeResult {
  const {
    enableLogging  = true,
    enableCors     = true,
    enableHelmet   = true,
    enableSanitize = true,
    enableDocs     = true,
    uploadDir      = './uploads',
  } = options

  const app   = new Hono()
  const store: DataStore = new Map()

  if (enableHelmet)   app.use('*', createHelmetMiddleware(spec.security))
  if (enableCors)     app.use('*', createCorsMiddleware(spec.cors))
  if (spec.rateLimit) app.use('*', createRateLimitMiddleware(spec.rateLimit))
  if (enableSanitize) app.use('*', createSanitizeMiddleware())
  if (enableLogging)  app.use('*', logger())

  app.get('/health', (c) =>
    c.json({ status: 'ok', name: spec.name, version: spec.version })
  )

  const authMiddleware = spec.auth ? createAuthMiddleware(spec.auth) : undefined

  generateRoutes(spec, app, store, authMiddleware, uploadDir)

  const zodSchemas: Record<string, ResourceSchemas> = {}
  for (const resource of spec.resources) {
    zodSchemas[resource.name] = generateZodSchemas(resource)
  }

  const openApiSpec = generateOpenAPISpec(spec)
  if (enableDocs) mountScalarDocs(app, openApiSpec)

  return {
    app,
    prismaSchema: generatePrismaSchema(spec),
    zodSchemas,
    testSuite: generateTests(spec),
    openApiSpec,
    spec,
  }
}
