import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { ZeroAPISpec } from '../types/spec.js'
import type { DataStore } from '../types/store.js'
import type { ResourceSchemas } from '../generators/validation.js'
import type { OpenAPISpec } from '../docs/swagger.js'
import type { HandlerFn } from '../hooks/types.js'
import type { RateLimitStore } from '../ratelimit/store.js'
import type { LogLevel } from '../observability/logger.js'
import { generateRoutes } from '../generators/routes.js'
import { generatePrismaSchema } from '../generators/schema.js'
import { generateZodSchemas } from '../generators/validation.js'
import { generateTests } from '../generators/tests.js'
import { createAuthMiddleware } from '../auth/middleware.js'
import { mountAuthFlows } from '../auth/flows/index.js'
import { createHelmetMiddleware } from '../security/helmet.js'
import { createCorsMiddleware } from '../security/cors.js'
import { createRateLimitMiddleware } from '../security/ratelimit.js'
import { createSanitizeMiddleware } from '../security/sanitize.js'
import { generateOpenAPISpec } from '../docs/swagger.js'
import { mountScalarDocs } from '../docs/scalar.js'
import { createRequestIdMiddleware } from '../observability/requestId.js'
import { assertEnv } from '../env/validate.js'

export interface RuntimeOptions {
  enableLogging?: boolean
  enableCors?: boolean
  enableHelmet?: boolean
  enableSanitize?: boolean
  enableDocs?: boolean
  /** Directory for local file uploads. Defaults to "./uploads". */
  uploadDir?: string
  /** Chantier 1: Handler map — binds handler IDs (from hooks + customEndpoints) to functions. */
  handlers?: Record<string, HandlerFn>
  /** Chantier 2: Minimum log level. Defaults to 'info'. */
  logLevel?: LogLevel
  /** Chantier 3: External rate limit store (e.g. RedisRateLimitStore). Defaults to in-memory. */
  rateLimitStore?: RateLimitStore
  /** Chantier 4: Validate required env vars at startup; throws with a clear error on failure. */
  validateEnv?: boolean
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
 *  - Lifecycle hooks (beforeCreate/afterCreate/…) with handler injection
 *  - Custom endpoints per resource
 *  - OpenAPI 3.0 JSON + Scalar docs UI
 *  - Observability: request ID, /health with uptime, /ready
 *  - Auth flows: register, login, email verification, password reset, refresh, logout
 *  - Env var validation at boot
 */
export function createRuntime(spec: ZeroAPISpec, options: RuntimeOptions = {}): RuntimeResult {
  const {
    enableLogging  = true,
    enableCors     = true,
    enableHelmet   = true,
    enableSanitize = true,
    enableDocs     = true,
    uploadDir      = './uploads',
    handlers       = {},
    rateLimitStore,
    validateEnv: doValidateEnv = false,
  } = options

  // Chantier 4: Fail fast on missing env vars
  if (doValidateEnv) assertEnv(spec)

  const startTime = Date.now()
  const app   = new Hono()
  const store: DataStore = new Map()

  // Chantier 2: Request ID — always on (zero cost, maximum observability)
  app.use('*', createRequestIdMiddleware())

  if (enableHelmet)   app.use('*', createHelmetMiddleware(spec.security))
  if (enableCors)     app.use('*', createCorsMiddleware(spec.cors))
  if (spec.rateLimit) app.use('*', createRateLimitMiddleware(spec.rateLimit, rateLimitStore))
  if (enableSanitize) app.use('*', createSanitizeMiddleware())
  if (enableLogging)  app.use('*', logger())

  // Chantier 2: Health — enhanced with uptime
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      name: spec.name,
      version: spec.version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    })
  )

  // Chantier 2: Ready endpoint — signals the instance is ready to serve traffic
  app.get('/ready', (c) =>
    c.json({ status: 'ready', timestamp: new Date().toISOString() })
  )

  const authMiddleware = spec.auth ? createAuthMiddleware(spec.auth) : undefined

  // Chantier 1: Routes with hooks + custom endpoints
  generateRoutes(spec, app, store, authMiddleware, uploadDir, handlers)

  // Chantier 5: Auth flows (register/login/verify/reset/refresh/logout)
  if (spec.authFlows) {
    mountAuthFlows(app, spec)
  }

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
