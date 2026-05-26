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

// ── Query ─────────────────────────────────────────────────────────────────────
export { parseQueryParams, toPrismaQuery } from './query/builder.js'
export { applyFilters, applySorts, applyPagination, applyQuery } from './query/apply.js'

// ── Relations ─────────────────────────────────────────────────────────────────
export { applyIncludes, renderRelationFields, renderJoinModels } from './relations/index.js'

// ── Transactions ──────────────────────────────────────────────────────────────
export { executeTransaction } from './transactions/executor.js'

// ── Upload ────────────────────────────────────────────────────────────────────
export { uploadFile, validateFile, parseMaxSize, processFileFields } from './upload/index.js'
export { uploadLocal } from './upload/providers/local.js'
export { generatePresignedPutUrl } from './upload/providers/s3.js'

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  ZeroAPISpec, ResourceDefinition, FieldDefinition, FieldType, CrudAction,
  AuthConfig, GlobalAuthConfig, ResourceHooks, HookConfig,
  RoleDefinition, ResourceRBAC, RateLimitConfig, CorsConfig, SecurityConfig,
  RelationDefinition, RelationType,
  TxOperation, TxAction, TransactionConfig,
} from './types/spec.js'

export type { RuntimeResult, RuntimeOptions } from './runtime/index.js'
export type { ResourceSchemas } from './generators/validation.js'
export type { DataStore, ResourceStore } from './generators/routes.js'
export type { OpenAPISpec } from './docs/swagger.js'
export type { ParsedQuery, FilterMap, SortSpec, PaginationSpec } from './query/builder.js'
export type { QueryResult } from './query/apply.js'
export type { TxResult } from './transactions/executor.js'
export type { UploadResult, UploadError } from './upload/index.js'
export type { S3Config, PresignedUrlResult } from './upload/providers/s3.js'
export type { LocalUploadResult } from './upload/providers/local.js'
