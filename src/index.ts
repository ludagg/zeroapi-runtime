// ── Core ──────────────────────────────────────────────────────────────────────
export { createRuntime } from './runtime/index.js'
export { parseSpec, ParseError } from './parser/index.js'

// ── Generators ────────────────────────────────────────────────────────────────
export { generatePrismaSchema } from './generators/schema.js'
export { generateZodSchemas } from './generators/validation.js'
export { generateTests } from './generators/tests.js'
export { generateRoutes } from './generators/routes.js'

// ── Security ──────────────────────────────────────────────────────────────────
export { createHelmetMiddleware } from './security/helmet.js'
export { createCorsMiddleware } from './security/cors.js'
export { createRateLimitMiddleware } from './security/ratelimit.js'
export { createSanitizeMiddleware } from './security/sanitize.js'
export { createAuthMiddleware, AuthError } from './auth/middleware.js'

// ── RBAC ──────────────────────────────────────────────────────────────────────
export { getEffectiveRoles, extractRoleFromHeader, hasPermission } from './rbac/roles.js'
export { createPermissionMiddleware } from './rbac/permissions.js'

// ── Docs ──────────────────────────────────────────────────────────────────────
export { generateOpenAPISpec } from './docs/swagger.js'
export { renderScalarPage, mountScalarDocs } from './docs/scalar.js'

// ── Deploy ────────────────────────────────────────────────────────────────────
export { generateRailwayConfig, getRailwayDeployButton } from './deploy/external/railway.js'
export { generateRenderConfig, getRenderDeployButton } from './deploy/external/render.js'
export { generateVercelConfig, getVercelDeployButton } from './deploy/external/vercel.js'
export { generateFlyConfig, getFlyDeployButton } from './deploy/external/flyio.js'

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  ZeroAPISpec,
  ResourceDefinition,
  FieldDefinition,
  FieldType,
  CrudAction,
  AuthConfig,
  GlobalAuthConfig,
  ResourceHooks,
  HookConfig,
  RoleDefinition,
  ResourceRBAC,
  RateLimitConfig,
  CorsConfig,
  SecurityConfig,
} from './types/spec.js'

export type { RuntimeResult, RuntimeOptions } from './runtime/index.js'
export type { ResourceSchemas } from './generators/validation.js'
export type { DataStore, ResourceStore } from './generators/routes.js'
export type { OpenAPISpec } from './docs/swagger.js'
