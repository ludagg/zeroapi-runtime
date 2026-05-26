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
  /** Enable HTTP request logging. Defaults to true. */
  enableLogging?: boolean
  /** Enable CORS. Defaults to true (permissive unless spec.cors is set). */
  enableCors?: boolean
  /** Enable security headers (Helmet). Defaults to true. */
  enableHelmet?: boolean
  /** Enable XSS / injection sanitisation middleware. Defaults to true. */
  enableSanitize?: boolean
  /** Mount OpenAPI JSON + Scalar docs UI. Defaults to true. */
  enableDocs?: boolean
}

export interface RuntimeResult {
  /** Hono application with all routes, security, and docs registered. */
  app: Hono
  /** Generated Prisma schema string — write to prisma/schema.prisma. */
  prismaSchema: string
  /** Generated Zod schemas indexed by resource name. */
  zodSchemas: Record<string, ResourceSchemas>
  /** Generated Vitest test suite as a string. */
  testSuite: string
  /** Generated OpenAPI 3.0.3 spec object — served at /openapi.json. */
  openApiSpec: OpenAPISpec
  /** The spec used to build this runtime. */
  spec: ZeroAPISpec
}

/**
 * Core runtime factory.
 *
 * Consumes a validated ZeroAPISpec and wires up:
 *  - Security headers (Helmet)
 *  - Configurable CORS
 *  - Rate limiting (when spec.rateLimit is set)
 *  - XSS / injection sanitisation
 *  - JWT / API-key authentication (when spec.auth is set)
 *  - RBAC permission checks per resource action
 *  - REST routes (list / create / read / update / delete)
 *  - OpenAPI 3.0 JSON endpoint + Scalar docs UI
 *
 * The built-in store is in-memory (suitable for dev/testing).
 */
export function createRuntime(spec: ZeroAPISpec, options: RuntimeOptions = {}): RuntimeResult {
  const {
    enableLogging = true,
    enableCors = true,
    enableHelmet = true,
    enableSanitize = true,
    enableDocs = true,
  } = options

  const app = new Hono()
  const store: DataStore = new Map()

  // ── Middleware stack (order matters) ────────────────────────────────────────
  if (enableHelmet) {
    app.use('*', createHelmetMiddleware(spec.security))
  }

  if (enableCors) {
    app.use('*', createCorsMiddleware(spec.cors))
  }

  if (spec.rateLimit) {
    app.use('*', createRateLimitMiddleware(spec.rateLimit))
  }

  if (enableSanitize) {
    app.use('*', createSanitizeMiddleware())
  }

  if (enableLogging) {
    app.use('*', logger())
  }

  // ── Built-in endpoints ──────────────────────────────────────────────────────
  app.get('/health', (c) =>
    c.json({ status: 'ok', name: spec.name, version: spec.version })
  )

  // ── Auth middleware (passed into route generator) ───────────────────────────
  const authMiddleware = spec.auth ? createAuthMiddleware(spec.auth) : undefined

  // ── Resource routes + RBAC ──────────────────────────────────────────────────
  generateRoutes(spec, app, store, authMiddleware)

  // ── Generated artifacts ─────────────────────────────────────────────────────
  const zodSchemas: Record<string, ResourceSchemas> = {}
  for (const resource of spec.resources) {
    zodSchemas[resource.name] = generateZodSchemas(resource)
  }

  const openApiSpec = generateOpenAPISpec(spec)

  if (enableDocs) {
    mountScalarDocs(app, openApiSpec)
  }

  return {
    app,
    prismaSchema: generatePrismaSchema(spec),
    zodSchemas,
    testSuite: generateTests(spec),
    openApiSpec,
    spec,
  }
}
