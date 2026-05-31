// ── Core ──────────────────────────────────────────────────────────────────────
export { createRuntime } from './runtime/index.js'
export { parseSpec, ParseError } from './parser/index.js'

// ── Generators ────────────────────────────────────────────────────────────────
export { generatePrismaSchema } from './generators/schema.js'
export { generateZodSchemas } from './generators/validation.js'
export { generateTests } from './generators/tests.js'
export { generateRoutes } from './generators/routes.js'
export { generateSdk } from './sdk/generate.js'

// ── Security ──────────────────────────────────────────────────────────────────
export { createHelmetMiddleware } from './security/helmet.js'
export { createCorsMiddleware } from './security/cors.js'
export { createRateLimitMiddleware } from './security/ratelimit.js'
export { createAuthRateLimitMiddleware, DEFAULT_AUTH_RATE_LIMIT } from './security/auth-ratelimit.js'
export type { AuthRateLimitConfig } from './security/auth-ratelimit.js'
export { createSanitizeMiddleware } from './security/sanitize.js'
export { createAuthMiddleware, AuthError } from './auth/middleware.js'

// ── API Keys (Phase 1.1) ──────────────────────────────────────────────────────
export { generateApiKey, hashApiKey } from './auth/apikey.js'
export { MemoryApiKeyStore } from './auth/apikey-store.js'
export { mountApiKeyRoutes } from './auth/apikey-routes.js'
export { bootstrapMemoryApiKeysSync, bootstrapApiKeys } from './auth/apikey-bootstrap.js'
export { PrismaApiKeyStore } from './auth/prisma-apikey-store.js'
export { tryAutoLoadPrismaApiKeyStore } from './auth/apikey-autodetect.js'
export type { ApiKeyStore, ApiKeyRecord, CreateApiKeyInput } from './auth/apikey-store.js'
export type { GeneratedApiKey } from './auth/apikey.js'
export type { BootstrapApiKeyResult, BootstrapLogger } from './auth/apikey-bootstrap.js'
export type { PrismaLikeClient, PrismaApiKeyDelegate, PrismaApiKeyRow } from './auth/prisma-apikey-store.js'

// ── JWT user system (Phase 1.2) ───────────────────────────────────────────────
export { hashPassword, verifyPassword } from './auth/password.js'
export {
  generateAccessToken, verifyAccessToken,
  generateRefreshTokenValue, hashRefreshToken,
  parseTTL, getAccessTokenTTL, getRefreshTokenTTL,
  resolveJwtSecret, getJwtSecretEnvName,
} from './auth/jwt.js'
export { MemoryUserStore } from './auth/user-store.js'
export { MemoryRefreshTokenStore } from './auth/refresh-token-store.js'
export { PrismaUserStore } from './auth/prisma-user-store.js'
export { PrismaRefreshTokenStore } from './auth/prisma-refresh-token-store.js'
export { tryAutoLoadPrismaJwtStores } from './auth/jwt-autodetect.js'
export { mountJwtAuthRoutes } from './auth/jwt-routes.js'
// ── Token revocation (P1) ─────────────────────────────────────────────────────
export { MemoryTokenRevocationStore } from './auth/token-revocation-store.js'
export { PrismaTokenRevocationStore } from './auth/prisma-token-revocation-store.js'
export type { TokenRevocationStore, RevokedTokenInfo } from './auth/token-revocation-store.js'
export type { PrismaRevocationLikeClient, PrismaRevokedTokenDelegate } from './auth/prisma-token-revocation-store.js'
export type { PasswordHash } from './auth/password.js'
export type { JwtPayload, JwtSecretLogger } from './auth/jwt.js'
export type { UserStore, UserRecord, CreateUserInput, CreateOAuthUserInput } from './auth/user-store.js'
export type {
  RefreshTokenStore, RefreshTokenRecord, CreateRefreshTokenInput,
} from './auth/refresh-token-store.js'
export type {
  PrismaUserLikeClient, PrismaUserDelegate, PrismaUserRow,
} from './auth/prisma-user-store.js'
export type {
  PrismaRefreshTokenLikeClient, PrismaRefreshTokenDelegate, PrismaRefreshTokenRow,
} from './auth/prisma-refresh-token-store.js'

// ── OAuth (Phase 1.4) ─────────────────────────────────────────────────────────
export { MemoryOAuthAccountStore } from './auth/oauth-account-store.js'
export { PrismaOAuthAccountStore } from './auth/prisma-oauth-account-store.js'
export { MemoryOAuthStateStore } from './auth/oauth-state.js'
export { mountOAuthRoutes, listConfiguredOAuthProviderNames } from './auth/oauth-routes.js'
export {
  getOAuthProvider, isProviderImplemented,
  OAuthNotImplementedError, OAuthProviderError,
} from './auth/oauth-providers.js'
export {
  OAUTH_CALLBACK_BASE_ENV, buildOAuthCallbackUrl, getOAuthCallbackUrls,
  resolveOAuthBaseUrl, readProviderCredentials,
} from './auth/oauth-config.js'
export type {
  OAuthAccountStore, OAuthAccountRecord, CreateOAuthAccountInput,
} from './auth/oauth-account-store.js'
export type {
  PrismaOAuthAccountLikeClient, PrismaOAuthAccountDelegate, PrismaOAuthAccountRow,
} from './auth/prisma-oauth-account-store.js'
export type { OAuthStateStore, OAuthStateRecord } from './auth/oauth-state.js'
export type { OAuthUserInfo, OAuthProviderDescriptor } from './auth/oauth-providers.js'
export type { OAuthCallbackUrl, OAuthWarningLogger } from './auth/oauth-config.js'
export type { MountOAuthRoutesOptions } from './auth/oauth-routes.js'

// ── RBAC ──────────────────────────────────────────────────────────────────────
export { getEffectiveRoles, extractRoleFromHeader, hasPermission } from './rbac/roles.js'
export { createPermissionMiddleware } from './rbac/permissions.js'
export {
  buildResourcePermissionGuard, getRequesterIdentity, getOwnershipFilter,
  resourceHasOwnOnly, isAuthEnabled,
} from './rbac/resource-permissions.js'
export type { RequesterIdentity, OwnershipFilter } from './rbac/resource-permissions.js'

// ── Docs ──────────────────────────────────────────────────────────────────────
export { generateOpenAPISpec } from './docs/swagger.js'
export { renderScalarPage, mountScalarDocs } from './docs/scalar.js'
export { generateReadme } from './docs/readme.js'
export { generatePostmanCollection, POSTMAN_SCHEMA_V2_1 } from './docs/postman.js'
export type {
  PostmanCollection, PostmanInfo, PostmanVariable, PostmanAuth, PostmanAuthEntry,
  PostmanItem, PostmanFolderItem, PostmanRequestItem, PostmanRequestNode,
  PostmanUrl, PostmanUrlVariable, PostmanQueryParam, PostmanHeader,
  PostmanBody, PostmanRawBody, PostmanFormDataBody, PostmanFormDataEntry,
  PostmanEvent, PostmanScript,
} from './docs/postman.js'

// ── Deploy ────────────────────────────────────────────────────────────────────
export { generateRailwayConfig, getRailwayDeployButton } from './deploy/external/railway.js'
export { generateRenderConfig, getRenderDeployButton } from './deploy/external/render.js'
export { generateVercelConfig, getVercelDeployButton } from './deploy/external/vercel.js'
export { generateFlyConfig, getFlyDeployButton } from './deploy/external/flyio.js'
export { generatePackageJson, getRequiredDependencies } from './deploy/dependencies.js'
export type { AggregatedDependency, DependencySource, PackageJsonOptions } from './deploy/dependencies.js'

// ── Query ─────────────────────────────────────────────────────────────────────
export { parseQueryParams, toPrismaQuery } from './query/builder.js'
export { applyFilters, applySorts, applyPagination, applyQuery, applySearch } from './query/apply.js'

// ── Relations ─────────────────────────────────────────────────────────────────
export {
  applyIncludes, renderRelationFields, renderJoinModels,
  validateIncludes, normalizeTopLevelRelations,
  SYSTEM_RESOURCES, SYSTEM_RESOURCE_SAFE_FIELDS,
  isSystemResourceName, isSystemResourceActive, projectSystemResource,
  cascadeSystemResourceDelete, cascadeSystemResourceDeletePrisma,
  checkIncludeDepth, DEFAULT_MAX_INCLUDE_DEPTH,
} from './relations/index.js'
export type {
  IncludeValidationResult, IncludeOwnershipContext,
  SystemResourceName, SystemResourceResolver, SystemResourceResolvers,
  CascadeResult,
} from './relations/index.js'

// ── Transactions ──────────────────────────────────────────────────────────────
export { executeTransaction } from './transactions/executor.js'

// ── Upload ────────────────────────────────────────────────────────────────────
export { uploadFile, validateFile, parseMaxSize, processFileFields } from './upload/index.js'
export { uploadLocal } from './upload/providers/local.js'
export { generatePresignedPutUrl } from './upload/providers/s3.js'

// ── Webhooks (Phase 3.3) ──────────────────────────────────────────────────────
export {
  MemoryWebhookStore,
  WebhookWorker, computeBackoffDelay, endpointSubscribesTo,
  emitWebhook, buildResourceEventType,
  signPayload, verifySignature, generateWebhookSecret,
  SIGNATURE_HEADER, EVENT_TYPE_HEADER, EVENT_ID_HEADER,
  mountWebhookAdminRoutes, mountWebhookInboundRoutes,
  InboundEventLog, renderWebhookModels,
} from './webhooks/index.js'
export type {
  WebhookStore, WebhookEndpointRecord, WebhookEventRecord, WebhookEventStatus,
  CreateWebhookEndpointInput, CreateWebhookEventInput,
  ClaimEventsOptions, UpdateAfterAttemptInput,
  EmitWebhookOptions, WebhookWorkerOptions,
  AdminRoutesOptions, InboundSourceConfig, InboundRoutesOptions, InboundEventRecord,
} from './webhooks/index.js'

// ── Storage (Phase 3.2) ───────────────────────────────────────────────────────
export {
  LocalStorage, S3Storage,
  resolveStorageProvider, LOCAL_IN_PROD_WARNING,
  mountUploadRoutes, mountLocalUploadRoute,
  readS3ConfigFromEnv, hasS3EnvConfig, loadS3Module,
  S3_ENDPOINT_ENV, S3_BUCKET_ENV, S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV, S3_REGION_ENV, S3_PUBLIC_URL_ENV,
} from './storage/index.js'
export type {
  StorageProvider, UploadInput, UploadOutput,
  LocalStorageOptions, S3StorageConfig, S3Module,
  ResolveStorageOptions, StorageBootLogger, UploadRoutesOptions,
} from './storage/index.js'

// ── Hooks (Chantier 1) ────────────────────────────────────────────────────────
export { executeHook } from './hooks/runner.js'
export type { HandlerContext, HandlerFn } from './hooks/types.js'

// ── Observability (Chantier 2) ────────────────────────────────────────────────
export { createLogger } from './observability/logger.js'
export { createRequestIdMiddleware } from './observability/requestId.js'
export type { Logger, LogLevel } from './observability/logger.js'

// ── Rate Limit Stores (Chantier 3) ────────────────────────────────────────────
export { MemoryRateLimitStore } from './ratelimit/memoryStore.js'
export { RedisRateLimitStore } from './ratelimit/redisStore.js'
export type { RateLimitStore } from './ratelimit/store.js'
export type { RedisLike } from './ratelimit/redisStore.js'

// ── Env Validation (Chantier 4) ───────────────────────────────────────────────
export { validateEnv, assertEnv } from './env/validate.js'
export type { EnvValidationResult } from './env/validate.js'

// ── Env Management (Phase 3.1) ────────────────────────────────────────────────
export { getRequiredEnvVars } from './env/aggregate.js'
export type { AggregatedEnvVar, EnvVarSource } from './env/aggregate.js'
export { generateEnvExample } from './env/example.js'
export { validateAndGenerateEnv, getConfigCheck } from './env/boot.js'
export type { BootEnvOptions, BootEnvResult, ConfigCheck, EnvBootLogger } from './env/boot.js'

// ── Auth Flows (Chantier 5) ───────────────────────────────────────────────────
export { mountAuthFlows } from './auth/flows/index.js'

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  ZeroAPISpec, ResourceDefinition, FieldDefinition, FieldType, CrudAction,
  AuthConfig, GlobalAuthConfig, ResourceHooks, CustomEndpointDef, HttpMethod,
  RoleDefinition, ResourceRBAC, RateLimitConfig, CorsConfig, SecurityConfig,
  RelationDefinition, RelationType,
  TxOperation, TxAction, TransactionConfig,
  AuthFlowsConfig, LockoutConfig,
  // Phase 0
  JwtAuthConfig, ApiKeyAuthConfig, OAuthConfig, OAuthProviderConfig, OAuthProviderName,
  SpecRelation, SpecRelationType,
  EnvVarDefinition,
  PermissionDefinition, PermissionRule, PermissionAction,
  FeaturesConfig, FileUploadFeature, WebhooksFeature, SearchFeature,
  RateLimitFeature, PaginationFeature,
} from './types/spec.js'

export type { RuntimeResult, RuntimeOptions } from './runtime/index.js'
export type { ResourceSchemas } from './generators/validation.js'
export type { DataStore, ResourceMap } from './types/store.js'
export type { ResourceStore, ResourceStoreProvider } from './store/resource-store.js'
export { MemoryResourceStore, MemoryResourceStoreProvider } from './store/resource-store.js'
export {
  PrismaResourceStore, PrismaResourceStoreProvider, prismaResourceDelegateName,
} from './store/prisma-resource-store.js'
export type { PrismaResourceDelegate, PrismaResourceLikeClient } from './store/prisma-resource-store.js'
export { tryAutoLoadPrismaResourceClient } from './store/resource-store-autodetect.js'
export type { OpenAPISpec } from './docs/swagger.js'
export type { ParsedQuery, FilterMap, SortSpec, PaginationSpec, ParseQueryOptions } from './query/builder.js'
export type { QueryResult, PaginationMeta, ApplyQueryOptions } from './query/apply.js'
export type { TxResult } from './transactions/executor.js'
export type { UploadResult, UploadError } from './upload/index.js'
export type { S3Config, PresignedUrlResult } from './upload/providers/s3.js'
export type { LocalUploadResult } from './upload/providers/local.js'
