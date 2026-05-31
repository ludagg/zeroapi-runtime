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
import { MemoryApiKeyStore, type ApiKeyStore } from '../auth/apikey-store.js'
import { mountApiKeyRoutes } from '../auth/apikey-routes.js'
import { bootstrapMemoryApiKeysSync, bootstrapApiKeys, type BootstrapLogger } from '../auth/apikey-bootstrap.js'
import { PrismaApiKeyStore, type PrismaLikeClient } from '../auth/prisma-apikey-store.js'
import { tryAutoLoadPrismaApiKeyStore } from '../auth/apikey-autodetect.js'
import { MemoryUserStore, type UserStore } from '../auth/user-store.js'
import { MemoryRefreshTokenStore, type RefreshTokenStore } from '../auth/refresh-token-store.js'
import { PrismaUserStore, type PrismaUserLikeClient } from '../auth/prisma-user-store.js'
import { PrismaRefreshTokenStore, type PrismaRefreshTokenLikeClient } from '../auth/prisma-refresh-token-store.js'
import { tryAutoLoadPrismaJwtStores } from '../auth/jwt-autodetect.js'
import { mountJwtAuthRoutes } from '../auth/jwt-routes.js'
import { resolveJwtSecret, getAccessTokenTTL, type JwtSecretLogger } from '../auth/jwt.js'
import {
  MemoryTokenRevocationStore, type TokenRevocationStore,
} from '../auth/token-revocation-store.js'
import {
  PrismaTokenRevocationStore, type PrismaRevocationLikeClient,
} from '../auth/prisma-token-revocation-store.js'
import { MemoryOAuthAccountStore, type OAuthAccountStore } from '../auth/oauth-account-store.js'
import { MemoryOAuthStateStore, type OAuthStateStore } from '../auth/oauth-state.js'
import { mountOAuthRoutes } from '../auth/oauth-routes.js'
import { resolveOAuthBaseUrl, type OAuthWarningLogger } from '../auth/oauth-config.js'
import { createHelmetMiddleware } from '../security/helmet.js'
import { createCorsMiddleware } from '../security/cors.js'
import { createRateLimitMiddleware } from '../security/ratelimit.js'
import {
  createAuthRateLimitMiddleware, DEFAULT_AUTH_RATE_LIMIT, type AuthRateLimitConfig,
} from '../security/auth-ratelimit.js'
import { createSanitizeMiddleware } from '../security/sanitize.js'
import { generateOpenAPISpec } from '../docs/swagger.js'
import { mountScalarDocs } from '../docs/scalar.js'
import { createRequestIdMiddleware } from '../observability/requestId.js'
import { assertEnv } from '../env/validate.js'
import { validateAndGenerateEnv, getConfigCheck, type EnvBootLogger } from '../env/boot.js'
import {
  resolveStorageProvider, mountUploadRoutes, mountLocalUploadRoute,
  LocalStorage, type StorageProvider, type StorageBootLogger,
} from '../storage/index.js'
import {
  MemoryWebhookStore, PrismaWebhookStore, tryAutoLoadPrismaWebhookStore,
  WebhookWorker, emitWebhook as emitWebhookImpl,
  mountWebhookAdminRoutes, mountWebhookInboundRoutes,
  type WebhookStore, type WebhookWorkerOptions, type InboundSourceConfig,
  type InboundRoutesOptions, type PrismaWebhookLikeClient,
} from '../webhooks/index.js'
import {
  cascadeSystemResourceDelete, cascadeSystemResourceDeletePrisma,
  DEFAULT_MAX_INCLUDE_DEPTH,
  type SystemResourceResolvers, type CascadeResult,
} from '../relations/index.js'
import {
  MemoryResourceStoreProvider, type ResourceStoreProvider,
} from '../store/resource-store.js'
import {
  PrismaResourceStoreProvider, prismaResourceDelegateName,
  type PrismaResourceLikeClient,
} from '../store/prisma-resource-store.js'
import { tryAutoLoadPrismaResourceClient } from '../store/resource-store-autodetect.js'

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
  /**
   * Maximum `?include=` nesting depth (dotted segments per path). Beyond it the
   * route answers 400 BEFORE building/executing the query, so a deep
   * `?include=a.b.c.d.e…` can't generate a runaway nested SQL query. Default 4.
   */
  maxIncludeDepth?: number
  /** Chantier 4: Validate required env vars at startup; throws with a clear error on failure. */
  validateEnv?: boolean
  /**
   * Phase 1.1: explicit API-key store. Takes precedence over `prisma`/auto-detect.
   * Defaults to `PrismaApiKeyStore` when a Prisma client is detected, otherwise
   * `MemoryApiKeyStore` in dev/test. In production (`NODE_ENV=production`) the
   * runtime refuses to fall back to memory — pass an explicit store to opt in.
   */
  apiKeyStore?: ApiKeyStore
  /**
   * Phase 1.1: Prisma client to back the API-key store. Auto-wraps in `PrismaApiKeyStore`.
   *
   * Persistence chantier: the SAME client also backs the business-resource CRUD
   * store. When provided (or when a Prisma client is auto-detected via
   * `DATABASE_URL`), user resources (Product, Todo, ...) are persisted to the
   * database via `PrismaResourceStore` instead of the volatile in-memory map,
   * so they survive restarts. Without it, resources stay in memory (dev/test).
   */
  prisma?: PrismaLikeClient
  /** Phase 1.1: Receives bootstrap log lines instead of console.log. Useful in tests. */
  apiKeyBootstrapLogger?: BootstrapLogger
  /**
   * Phase 1.2: explicit user store for the JWT user system. Takes precedence over
   * `prisma`/auto-detect. Defaults to `PrismaUserStore` when a Prisma client is
   * detected, otherwise `MemoryUserStore` in dev/test. Production refuses the
   * memory fallback — pass an explicit store to opt in.
   */
  userStore?: UserStore
  /** Phase 1.2: explicit refresh-token store. Same resolution rules as `userStore`. */
  refreshTokenStore?: RefreshTokenStore
  /**
   * P1: explicit access-token revocation store (jti blacklist + per-user
   * cutoff). Defaults to `PrismaTokenRevocationStore` when a Prisma client is
   * detected, otherwise `MemoryTokenRevocationStore`.
   */
  revocationStore?: TokenRevocationStore
  /**
   * P1: per-IP rate limit on `/auth/login` + `/auth/register`. Defaults to
   * 20 requests / 15 min per IP. Pass a custom `{ windowMs, max }` to harden in
   * production, or `false` to disable.
   */
  authRateLimit?: AuthRateLimitConfig | false
  /** Phase 1.2: Prisma client to back the user / refresh-token stores. */
  prismaJwt?: PrismaUserLikeClient & PrismaRefreshTokenLikeClient
  /** Phase 1.2: receives the JWT secret warning when an ephemeral secret is used in dev. */
  jwtSecretLogger?: JwtSecretLogger
  /** Phase 1.4: explicit OAuth account-link store. Defaults to in-memory. */
  oauthAccountStore?: OAuthAccountStore
  /** Phase 1.4: explicit OAuth CSRF-state store. Defaults to in-memory. */
  oauthStateStore?: OAuthStateStore
  /** Phase 1.4: receives warnings when OAUTH_CALLBACK_BASE_URL is missing. */
  oauthWarningLogger?: OAuthWarningLogger
  /** Phase 1.4: override `fetch` used by OAuth providers (for tests / proxies). */
  oauthFetch?: typeof fetch
  /** Phase 3.1: receives warnings about missing / auto-generated env vars. Defaults to `console.warn`. */
  envBootLogger?: EnvBootLogger
  /**
   * Phase 3.2: explicit storage provider for `features.fileUpload`. Takes
   * precedence over the auto-resolution that reads `spec.features.fileUpload`
   * + S3 env vars.
   */
  storageProvider?: StorageProvider
  /** Phase 3.2: receives storage boot warnings (e.g. local+prod). Defaults to `console.warn`. */
  storageBootLogger?: StorageBootLogger
  /**
   * Phase 3.3: explicit webhook store. Defaults to `MemoryWebhookStore` when
   * `features.webhooks` is enabled. Plug in a Prisma-backed implementation in
   * production.
   */
  webhookStore?: WebhookStore
  /** Phase 3.3: overrides for the background delivery worker (interval, fetch, ...). */
  webhookWorkerOptions?: WebhookWorkerOptions
  /** Phase 3.3: skip starting the worker (tests). The worker is still constructed. */
  webhookWorkerAutostart?: boolean
  /** Phase 3.3: configure inbound webhook sources (signature header, secret env, ...). */
  webhookInboundSources?: InboundSourceConfig[]
  /** Phase 3.3: forwarded to `mountWebhookInboundRoutes` — onEvent, log, eventLog. */
  webhookInboundOptions?: InboundRoutesOptions
}

export interface RuntimeResult {
  app: Hono
  prismaSchema: string
  zodSchemas: Record<string, ResourceSchemas>
  testSuite: string
  openApiSpec: OpenAPISpec
  spec: ZeroAPISpec
  /**
   * Phase 1.1: resolves once startup tasks (API-key bootstrap against an
   * external store) complete. Awaiting this before `app.fetch`/`listen` ensures
   * the bootstrap key is persisted before traffic arrives. With the in-memory
   * store bootstrap is synchronous and `ready` resolves immediately.
   */
  ready: Promise<void>
  /**
   * Phase 3.3: webhook subsystem handles — present only when
   * `features.webhooks` is enabled. `worker.stop()` must be called on shutdown
   * (long-running tests, app teardown).
   */
  webhooks?: {
    store: WebhookStore
    worker: WebhookWorker
  }
  /**
   * Delete a system-resource row (currently only "User") and apply the
   * `onDelete` policy declared by every user-defined relation that points at
   * it: Cascade deletes children, SetNull clears the FK, Restrict throws.
   *
   * Only available when the matching auth feature is active (e.g. auth.jwt).
   */
  deleteSystemResource?: (resource: string, id: string) => Promise<CascadeResult>
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
    maxIncludeDepth,
    validateEnv: doValidateEnv = false,
    apiKeyStore: providedApiKeyStore,
    prisma,
    apiKeyBootstrapLogger,
    userStore: providedUserStore,
    refreshTokenStore: providedRefreshTokenStore,
    revocationStore: providedRevocationStore,
    authRateLimit,
    prismaJwt,
    jwtSecretLogger,
    oauthAccountStore: providedOAuthAccountStore,
    oauthStateStore: providedOAuthStateStore,
    oauthWarningLogger,
    oauthFetch,
    envBootLogger,
    storageProvider: providedStorageProvider,
    storageBootLogger,
    webhookStore: providedWebhookStore,
    webhookWorkerOptions,
    webhookWorkerAutostart = true,
    webhookInboundSources = [],
    webhookInboundOptions,
  } = options

  // Chantier 4: Fail fast on missing env vars (legacy spec.requiredEnv)
  if (doValidateEnv) assertEnv(spec)

  // Phase 3.1: walk the env block + implicit feature vars. Generates random
  // values for `generate: true`, warns in dev, fails in production on missing
  // required *explicit* vars. Implicit vars stay non-fatal so feature-specific
  // guards (Prisma autodetect, JWT secret resolution) keep their own errors.
  validateAndGenerateEnv(spec, envBootLogger ? { log: envBootLogger } : {})

  const startTime = Date.now()
  const app   = new Hono()
  const store: DataStore = new Map()

  // Persistence chantier: resolve the resource-CRUD backend once. Prisma (DB,
  // durable) when a client is provided / auto-detected, else the in-memory map
  // (volatile, dev/test default). Mirrors `resolveApiKeyStore`. The raw `store`
  // map is still threaded to relations / transactions / custom endpoints, which
  // remain memory-based in this chantier.
  const resourceStoreProvider: ResourceStoreProvider = resolveResourceStore({
    store,
    ...(prisma ? { prisma: prisma as unknown as PrismaResourceLikeClient } : {}),
  })

  // Chantier 2: Request ID — always on (zero cost, maximum observability)
  app.use('*', createRequestIdMiddleware())

  if (enableHelmet)   app.use('*', createHelmetMiddleware(spec.security))
  if (enableCors)     app.use('*', createCorsMiddleware(spec.cors))
  if (spec.rateLimit) app.use('*', createRateLimitMiddleware(spec.rateLimit, rateLimitStore))
  if (enableSanitize) app.use('*', createSanitizeMiddleware())
  if (enableLogging)  app.use('*', logger())

  // Chantier 2: Health — enhanced with uptime
  // Phase 3.1: configCheck reports missing required env vars (names only, never values)
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      name: spec.name,
      version: spec.version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      configCheck: getConfigCheck(spec),
    })
  )

  // Chantier 2: Ready endpoint — signals the instance is ready to serve traffic
  app.get('/ready', (c) =>
    c.json({ status: 'ready', timestamp: new Date().toISOString() })
  )

  // Phase 1.1: real API-key verification — pick a store and bootstrap an initial key
  const apiKeyAuthEnabled =
    spec.auth?.strategy === 'apikey' || spec.auth?.apikey?.enabled === true
  let apiKeyStore: ApiKeyStore | undefined
  let ready: Promise<void> = Promise.resolve()

  if (spec.auth && apiKeyAuthEnabled) {
    apiKeyStore = resolveApiKeyStore({ providedApiKeyStore, prisma })

    if (apiKeyStore instanceof MemoryApiKeyStore) {
      bootstrapMemoryApiKeysSync(spec.auth, apiKeyStore, apiKeyBootstrapLogger)
    } else {
      ready = bootstrapApiKeys(spec.auth, apiKeyStore, apiKeyBootstrapLogger).then(() => { /* void */ })
    }
  }

  // Phase 1.2: JWT user system — resolve secret + stores, then mount routes
  const jwtUserSystemEnabled = spec.auth?.jwt?.enabled === true
  let jwtSecret: string | undefined
  let userStore: UserStore | undefined
  let refreshTokenStore: RefreshTokenStore | undefined
  // P1: access-token revocation store (jti blacklist + per-user cutoff).
  let revocationStore: TokenRevocationStore | undefined

  if (spec.auth && jwtUserSystemEnabled) {
    jwtSecret = resolveJwtSecret(spec.auth, jwtSecretLogger)
    const resolved = resolveJwtStores({
      providedUserStore,
      providedRefreshTokenStore,
      ...(providedRevocationStore ? { providedRevocationStore } : {}),
      prismaJwt,
    })
    userStore = resolved.userStore
    refreshTokenStore = resolved.refreshTokenStore
    revocationStore = resolved.revocationStore
  }

  const authMiddleware = spec.auth ? createAuthMiddleware(spec.auth, apiKeyStore, jwtSecret, revocationStore) : undefined

  // P1: per-IP rate limit on auth endpoints (brute-force defence; configurable
  // via `authRateLimit`, disablable with `false`). Registered BEFORE the auth
  // routes so Hono runs it first; covers both the JWT user system and legacy
  // auth flows.
  if (authRateLimit !== false && (jwtUserSystemEnabled || spec.authFlows)) {
    const authRlMw = createAuthRateLimitMiddleware(authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT, rateLimitStore)
    app.use('/auth/login', authRlMw)
    app.use('/auth/register', authRlMw)
  }

  // Phase 1.1: admin routes for managing API keys (protected by the auth middleware itself)
  if (spec.auth && apiKeyStore && authMiddleware) {
    mountApiKeyRoutes(app, spec.auth, apiKeyStore, authMiddleware)
  }

  // Phase 1.2: JWT user routes — must mount BEFORE generateRoutes so /auth/* paths win
  if (spec.auth && jwtUserSystemEnabled && jwtSecret && userStore && refreshTokenStore) {
    mountJwtAuthRoutes(app, spec.auth, jwtSecret, userStore, refreshTokenStore, revocationStore)
  }

  // Phase 1.4: OAuth routes — same constraint (mount before generateRoutes).
  const oauthEnabled = (spec.auth?.oauth?.providers?.length ?? 0) > 0
  if (
    spec.auth && oauthEnabled && jwtUserSystemEnabled &&
    jwtSecret && userStore && refreshTokenStore
  ) {
    const oauthAccountStore = providedOAuthAccountStore ?? new MemoryOAuthAccountStore()
    const oauthStateStore = providedOAuthStateStore ?? new MemoryOAuthStateStore()
    const baseUrl = resolveOAuthBaseUrl(spec.auth, oauthWarningLogger)
    mountOAuthRoutes(
      app, spec.auth, jwtSecret, userStore, refreshTokenStore,
      oauthAccountStore, oauthStateStore,
      { ...(baseUrl !== undefined ? { baseUrl } : {}), ...(oauthFetch ? { fetchImpl: oauthFetch } : {}) },
    )
  }

  // Phase 3.2: Storage provider + upload endpoints. Only when the
  // `features.fileUpload` block is enabled. When `local` is resolved we also
  // mount `GET /uploads/:key` so files are served directly by the runtime.
  const fileUploadFeature = spec.features?.fileUpload
  if (fileUploadFeature?.enabled) {
    const storage = providedStorageProvider ?? resolveStorageProvider(fileUploadFeature, {
      local: { uploadDir },
      ...(storageBootLogger ? { log: storageBootLogger } : {}),
    })
    mountUploadRoutes(app, storage, fileUploadFeature, {
      ...(authMiddleware ? { authMiddleware } : {}),
    })
    if (storage instanceof LocalStorage) {
      mountLocalUploadRoute(app, storage)
    }
  }

  // Phase 3.3: Webhooks — outbound emitter, admin routes, inbound sources, worker.
  const webhooksFeature = spec.features?.webhooks
  const outboundEvents = new Set(webhooksFeature?.outbound ?? [])
  const inboundEvents = webhooksFeature?.inbound ?? []
  const webhooksEnabled = !!webhooksFeature && (outboundEvents.size > 0 || inboundEvents.length > 0)

  let webhooks: { store: WebhookStore; worker: WebhookWorker } | undefined
  let webhookEmitter: ((eventType: string, payload: unknown) => void) | undefined

  if (webhooksEnabled) {
    // Durable store when Prisma is active (reuse the already-resolved client so
    // we never spin up a second PrismaClient); autodetect; else in-memory.
    const wStore = resolveWebhookStore({
      ...(providedWebhookStore ? { providedWebhookStore } : {}),
      ...(resourceStoreProvider.prismaClient?.()
        ? { prismaClient: resourceStoreProvider.prismaClient() as unknown as PrismaWebhookLikeClient }
        : {}),
    })
    const wWorker = new WebhookWorker(wStore, webhookWorkerOptions ?? {})

    if (outboundEvents.size > 0) {
      // Gate at emit-time: only the events declared in `outbound` are dispatched.
      webhookEmitter = (eventType, payload) => {
        if (!outboundEvents.has(eventType) && !outboundEvents.has('*')) return
        // Fire-and-forget; never block the request.
        emitWebhookImpl(wStore, eventType, payload).catch(() => { /* swallow */ })
      }
      mountWebhookAdminRoutes(app, wStore, authMiddleware)
    }

    if (inboundEvents.length > 0) {
      mountWebhookInboundRoutes(app, buildInboundSources(inboundEvents, webhookInboundSources), webhookInboundOptions ?? {})
    }

    if (webhookWorkerAutostart && outboundEvents.size > 0) wWorker.start()
    webhooks = { store: wStore, worker: wWorker }
  }

  // Phase 2.2: system-resource resolvers for `?include=user` etc.
  // Backed by the same UserStore that powers /auth/me, with sensitive fields
  // (passwordHash, salt) projected out by `applyIncludes`.
  const systemResolvers: SystemResourceResolvers = {}
  if (userStore) {
    systemResolvers['user'] = async (id: string) => {
      const row = await userStore.findById(id)
      if (!row) return null
      return {
        id: row.id,
        email: row.email,
        role: row.role,
        emailVerified: row.emailVerified,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
      }
    }
  }

  // Chantier 1: Routes with hooks + custom endpoints
  generateRoutes(spec, app, store, authMiddleware, uploadDir, handlers, webhookEmitter, systemResolvers, resourceStoreProvider, maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH)

  // Chantier 5: Legacy auth flows — only when the new JWT user system is off,
  // since both register the same /auth/* paths.
  if (spec.authFlows && !jwtUserSystemEnabled) {
    mountAuthFlows(app, spec)
  }

  const zodSchemas: Record<string, ResourceSchemas> = {}
  for (const resource of spec.resources) {
    zodSchemas[resource.name] = generateZodSchemas(resource)
  }

  const openApiSpec = generateOpenAPISpec(spec)
  if (enableDocs) mountScalarDocs(app, openApiSpec)

  // Phase 2.2: cascade-aware delete for system resources. Walks user-defined
  // relations and enforces onDelete (Cascade / SetNull / Restrict) before
  // removing the system row itself.
  const userStoreRef = userStore
  // Prisma client backing the user-defined resources (P0-2). When present, the
  // cascade runs against the DB inside a single $transaction; otherwise it runs
  // against the in-memory Map.
  const resourcePrismaClient = resourceStoreProvider.prismaClient?.()
  const revocationStoreRef = revocationStore
  // P1: cut every live session of the deleted user — revoke all access tokens
  // issued before now. Runs AFTER the delete succeeds, so a rolled-back cascade
  // (failed delete) leaves the user and their sessions intact.
  const revokeDeletedUserSessions = async (id: string): Promise<void> => {
    if (!revocationStoreRef) return
    const now = new Date()
    const ttlSec = spec.auth ? getAccessTokenTTL(spec.auth) : 15 * 60
    await revocationStoreRef.revokeUser(id, now, new Date(now.getTime() + ttlSec * 1000))
  }
  const deleteSystemResource = userStoreRef
    ? async (name: string, id: string): Promise<CascadeResult> => {
        if (name !== 'User') {
          throw new Error(`deleteSystemResource: "${name}" is not supported (only "User")`)
        }
        // Prisma: Restrict-check + Cascade + SetNull + the User delete itself all
        // run in ONE atomic $transaction — if the User delete fails (e.g. a
        // remaining required FK), every child mutation is rolled back.
        if (resourcePrismaClient) {
          const tx$ = resourcePrismaClient as unknown as {
            $transaction: <T>(fn: (tx: PrismaResourceLikeClient) => Promise<T>) => Promise<T>
          }
          const result = await tx$.$transaction(async (tx) => {
            const r = await cascadeSystemResourceDeletePrisma(spec, tx, 'User', id)
            const userDelegate = tx[prismaResourceDelegateName('User')]
            if (userDelegate && typeof userDelegate.delete === 'function') {
              await userDelegate.delete({ where: { id } })
            }
            return r
          })
          await revokeDeletedUserSessions(id)
          return result
        }
        // Memory: Restrict checks run first inside cascadeSystemResourceDelete —
        // it throws before mutating anything if any FK is restricted.
        const result = cascadeSystemResourceDelete(spec, store, 'User', id)
        if ('delete' in userStoreRef && typeof (userStoreRef as { delete?: unknown }).delete === 'function') {
          await (userStoreRef as { delete: (id: string) => Promise<boolean> }).delete(id)
        }
        await revokeDeletedUserSessions(id)
        return result
      }
    : undefined

  return {
    app,
    prismaSchema: generatePrismaSchema(spec),
    zodSchemas,
    testSuite: generateTests(spec),
    openApiSpec,
    spec,
    ready,
    ...(webhooks ? { webhooks } : {}),
    ...(deleteSystemResource ? { deleteSystemResource } : {}),
  }
}

/**
 * Resolve inbound source configs from the spec's `features.webhooks.inbound`
 * list (event slugs like `"stripe.payment"`) plus the operator-supplied
 * overrides via `webhookInboundSources`. Each unique source slug becomes one
 * endpoint at `POST /webhooks/inbound/<source>`.
 */
function buildInboundSources(
  inboundEvents: string[],
  overrides: InboundSourceConfig[] = [],
): InboundSourceConfig[] {
  const overrideMap = new Map(overrides.map((o) => [o.source, o]))
  const sources = new Set<string>()
  for (const event of inboundEvents) {
    // "stripe.payment" → "stripe"; "stripe" → "stripe"
    const slug = event.split('.')[0]
    if (slug) sources.add(slug)
  }
  // Operator-defined overrides may add sources not declared in the spec.
  for (const o of overrides) sources.add(o.source)

  return [...sources].map((source) => {
    const override = overrideMap.get(source)
    return override ?? { source, secretEnv: `${source.toUpperCase()}_WEBHOOK_SECRET` }
  })
}

/**
 * Pick the resource-CRUD persistence backend, mirroring `resolveApiKeyStore`:
 *
 *   1. explicit `prisma` client → PrismaResourceStoreProvider (durable, DB)
 *   2. auto-detected Prisma when `DATABASE_URL` is set → same
 *   3. fallback → MemoryResourceStoreProvider over the runtime's `store` map
 *
 * The Memory provider wraps the SAME `DataStore` used by relations /
 * transactions / custom endpoints, so memory mode stays fully consistent.
 */
function resolveResourceStore(opts: {
  store: DataStore
  prisma?: PrismaResourceLikeClient
}): ResourceStoreProvider {
  const memory = new MemoryResourceStoreProvider(opts.store)
  const client = opts.prisma ?? tryAutoLoadPrismaResourceClient()
  // Prisma backs every resource whose model it exposes; the memory provider
  // catches any resource the client doesn't cover (see PrismaResourceStoreProvider).
  if (client) return new PrismaResourceStoreProvider(client, memory)
  return memory
}

/**
 * Pick the webhook store, mirroring the other store resolvers:
 *   1. explicit `providedWebhookStore`
 *   2. the already-resolved Prisma client → PrismaWebhookStore (durable, shared)
 *   3. auto-detected Prisma (DATABASE_URL + @prisma/client) → same
 *   4. fallback → MemoryWebhookStore
 *
 * Unlike the auth stores, webhooks are best-effort, so memory is an acceptable
 * fallback even in production (no hard refusal).
 */
function resolveWebhookStore(opts: {
  providedWebhookStore?: WebhookStore
  prismaClient?: PrismaWebhookLikeClient
}): WebhookStore {
  if (opts.providedWebhookStore) return opts.providedWebhookStore
  if (opts.prismaClient) return new PrismaWebhookStore(opts.prismaClient)
  return tryAutoLoadPrismaWebhookStore() ?? new MemoryWebhookStore()
}

/**
 * Pick the right ApiKeyStore for the current environment:
 *
 *   1. explicit `apiKeyStore` option (any environment)
 *   2. explicit `prisma` option → wrap in PrismaApiKeyStore
 *   3. auto-detect Prisma when `DATABASE_URL` is set
 *   4. dev/test fallback → MemoryApiKeyStore
 *
 * In production (`NODE_ENV=production`) step 4 throws instead of silently using
 * the volatile in-memory store — operators have to opt in explicitly.
 */
function resolveApiKeyStore(opts: {
  providedApiKeyStore?: ApiKeyStore
  prisma?: PrismaLikeClient
}): ApiKeyStore {
  if (opts.providedApiKeyStore) return opts.providedApiKeyStore
  if (opts.prisma) return new PrismaApiKeyStore(opts.prisma)

  const autodetected = tryAutoLoadPrismaApiKeyStore()
  if (autodetected) return autodetected

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'ZeroAPI: apikey auth is enabled in production but no Prisma client could be loaded. ' +
      'Install @prisma/client (with DATABASE_URL set) so the runtime can use PrismaApiKeyStore, ' +
      'or pass an explicit `apiKeyStore` option. Refusing to start with a volatile in-memory store.',
    )
  }
  return new MemoryApiKeyStore()
}

/**
 * Same fallback ladder as `resolveApiKeyStore`, but for the JWT user system —
 * explicit stores → `prismaJwt` client → auto-detected Prisma → in-memory.
 * Production refuses the memory fallback unless an explicit store was passed.
 */
function resolveJwtStores(opts: {
  providedUserStore?: UserStore
  providedRefreshTokenStore?: RefreshTokenStore
  providedRevocationStore?: TokenRevocationStore
  prismaJwt?: PrismaUserLikeClient & PrismaRefreshTokenLikeClient
}): { userStore: UserStore; refreshTokenStore: RefreshTokenStore; revocationStore: TokenRevocationStore } {
  if (opts.providedUserStore && opts.providedRefreshTokenStore) {
    return {
      userStore: opts.providedUserStore,
      refreshTokenStore: opts.providedRefreshTokenStore,
      revocationStore: opts.providedRevocationStore ?? new MemoryTokenRevocationStore(),
    }
  }

  if (opts.prismaJwt) {
    return {
      userStore: opts.providedUserStore ?? new PrismaUserStore(opts.prismaJwt),
      refreshTokenStore:
        opts.providedRefreshTokenStore ?? new PrismaRefreshTokenStore(opts.prismaJwt),
      revocationStore:
        opts.providedRevocationStore ??
        new PrismaTokenRevocationStore(opts.prismaJwt as unknown as PrismaRevocationLikeClient),
    }
  }

  const autodetected = tryAutoLoadPrismaJwtStores()
  if (autodetected) {
    return {
      userStore: opts.providedUserStore ?? autodetected.userStore,
      refreshTokenStore: opts.providedRefreshTokenStore ?? autodetected.refreshTokenStore,
      revocationStore: opts.providedRevocationStore ?? autodetected.revocationStore,
    }
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'ZeroAPI: auth.jwt is enabled in production but no Prisma client could be loaded. ' +
      'Install @prisma/client (with DATABASE_URL set) so the runtime can use PrismaUserStore + PrismaRefreshTokenStore, ' +
      'or pass explicit `userStore` and `refreshTokenStore` options. Refusing to start with volatile in-memory stores.',
    )
  }

  return {
    userStore: opts.providedUserStore ?? new MemoryUserStore(),
    refreshTokenStore: opts.providedRefreshTokenStore ?? new MemoryRefreshTokenStore(),
    revocationStore: opts.providedRevocationStore ?? new MemoryTokenRevocationStore(),
  }
}
