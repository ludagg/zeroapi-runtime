/** Supported primitive field types in the ZeroAPI DSL. */
export type FieldType =
  | 'string' | 'text' | 'number' | 'integer' | 'decimal' | 'boolean'
  | 'date' | 'datetime' | 'email' | 'url' | 'uuid'
  | 'file' | 'file[]'
  | 'json' | 'enum'

/** Definition of a single resource field, including optional file-specific constraints. */
export interface FieldDefinition {
  type: FieldType
  required?: boolean
  unique?: boolean
  index?: boolean
  default?: unknown
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  description?: string
  /** Allowed values when type === 'enum'. */
  values?: string[]
  // ── file-specific (only valid when type === 'file' | 'file[]') ───────────
  accept?: string[]
  maxSize?: string       // e.g. "5MB"
  storage?: 'r2' | 's3' | 'local'
  multiple?: boolean
}

/** Standard CRUD actions. */
export type CrudAction = 'list' | 'create' | 'read' | 'update' | 'delete'

/** Per-resource auth requirement. */
export interface AuthConfig {
  required: boolean
  roles?: string[]
  strategy?: 'jwt' | 'apikey' | 'bearer'
}

// ── Hooks (Chantier 1) ────────────────────────────────────────────────────────

/**
 * Lifecycle hook IDs for a resource.
 * Each value is a handler ID that must exist in createRuntime({ handlers }).
 * Before-hooks can throw to cancel the operation.
 * After-hooks are fire-and-forget (failures are ignored).
 */
export interface ResourceHooks {
  beforeCreate?: string
  afterCreate?: string
  beforeUpdate?: string
  afterUpdate?: string
  beforeDelete?: string
  afterDelete?: string
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A fully custom endpoint attached to a resource's router. */
export interface CustomEndpointDef {
  method: HttpMethod
  /** Path relative to the resource route, e.g. "/:id/publish" or "/stats". */
  path: string
  /** ID of the handler in the createRuntime({ handlers }) map. */
  handler: string
  /** Require global auth middleware when true. */
  auth?: boolean
  /** Require specific roles (implies auth). */
  roles?: string[]
}

/** Role-based access control per action. */
export interface ResourceRBAC {
  read?: string[]
  write?: string[]
  delete?: string[]
}

// ── Relations (per-resource, legacy) ──────────────────────────────────────────

export type RelationType = 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany'

export interface RelationDefinition {
  type: RelationType
  /** Name of the related resource (must exist in spec.resources). */
  resource: string
  /** FK field name on this resource (required for manyToOne / oneToOne owned side). */
  field?: string
  required?: boolean
  /** Join table name — required for manyToMany. */
  through?: string
  /** Extra fields stored on the join table. */
  fields?: Record<string, FieldDefinition>
  onDelete?: 'Cascade' | 'SetNull' | 'Restrict' | 'NoAction'
  /**
   * Self many-to-many only: names the FORWARD direction (edges this row owns).
   * e.g. `as: 'following'`. Enables `?include=following` / `?following=<id>`.
   */
  as?: string
  /**
   * Self many-to-many only: names the REVERSE direction (edges pointing at this
   * row). e.g. `reverseAs: 'followers'`. Enables `?include=followers` /
   * `?followers=<id>`.
   */
  reverseAs?: string
}

// ── Transactions ──────────────────────────────────────────────────────────────

export type TxAction = 'create' | 'update' | 'delete' | 'decrement' | 'increment'

export interface TxOperation {
  action: TxAction
  resource: string
  /** Key in the request body to read the related resource ID from. */
  idFrom?: string
  /** Field to increment / decrement. */
  field?: string
  /** Static amount (integer). */
  amount?: number
  /** Key in the request body to read the amount from. */
  amountFrom?: string
}

export interface TransactionConfig {
  trigger: 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  operations: TxOperation[]
}

// ── Resource ──────────────────────────────────────────────────────────────────

export interface ResourceDefinition {
  name: string
  description?: string
  fields: Record<string, FieldDefinition>
  endpoints?: CrudAction[]
  auth?: AuthConfig
  hooks?: ResourceHooks
  rbac?: ResourceRBAC
  relations?: RelationDefinition[]
  transactions?: TransactionConfig[]
  customEndpoints?: CustomEndpointDef[]
  /** Soft-delete: keep rows and mark a deletedAt column. */
  softDelete?: boolean
  /** Auto-managed createdAt/updatedAt columns (default: true). */
  timestamps?: boolean
  /** Field names indexed for full-text search. */
  searchable?: string[]
}

// ── Global config ─────────────────────────────────────────────────────────────

/**
 * Top-level auth configuration.
 *
 * Two shapes are accepted (both backwards-compatible):
 *   - Legacy: { strategy, secret?, header? } — single strategy
 *   - Modern: { enabled, strategies, jwt?, apikey?, oauth?, ... } — multi-strategy
 *
 * All fields are optional at the type level; the parser fills defaults.
 */
export interface JwtAuthConfig {
  /** Phase 1.2: opt-in flag that activates the JWT user system (register/login/refresh/me). */
  enabled?: boolean
  accessTokenTTL?: string
  refreshTokenTTL?: string
  secretEnv?: string
}

export interface ApiKeyAuthConfig {
  enabled: boolean
  header?: string
  prefix?: string
}

export type OAuthProviderName = 'google' | 'apple' | 'github'

export interface OAuthProviderConfig {
  name: OAuthProviderName
  clientIdEnv: string
  clientSecretEnv: string
  scopes?: string[]
}

export interface OAuthConfig {
  providers: OAuthProviderConfig[]
}

export interface GlobalAuthConfig {
  // ── Modern shape ───────────────────────────────────────────────────────
  enabled?: boolean
  strategies?: ('jwt' | 'apikey' | 'oauth')[]
  jwt?: JwtAuthConfig
  apikey?: ApiKeyAuthConfig
  oauth?: OAuthConfig
  emailVerification?: boolean
  passwordReset?: boolean
  // ── Legacy shape (kept for backwards compatibility) ────────────────────
  strategy?: 'jwt' | 'apikey' | 'bearer'
  secret?: string
  header?: string
}

export interface RoleDefinition {
  name: string
  description?: string
  inherits?: string[]
}

export interface RateLimitConfig {
  windowMs: number
  max: number
  byUser?: boolean
  message?: string
}

export interface CorsConfig {
  origins: string[]
  methods?: string[]
  headers?: string[]
  credentials?: boolean
}

export interface SecurityConfig {
  contentSecurityPolicy?: boolean
  hsts?: boolean
  noSniff?: boolean
  frameguard?: boolean | 'DENY' | 'SAMEORIGIN'
  xssProtection?: boolean
  referrerPolicy?: string
}

// ── Auth flows (Chantier 5) ───────────────────────────────────────────────────

export interface LockoutConfig {
  /** Number of failed login attempts before locking. Default: 5. */
  maxAttempts: number
  /** Lock duration in milliseconds. Default: 15 minutes. */
  windowMs: number
}

export interface AuthFlowsConfig {
  /** Enable email verification flow (POST /auth/verify-email). */
  emailVerification?: boolean
  /** Enable password reset flow (POST /auth/forgot-password + /auth/reset-password). */
  passwordReset?: boolean
  /** Enable refresh token rotation (POST /auth/refresh). */
  refreshTokens?: boolean
  /** Enable token revocation (POST /auth/logout). */
  revocation?: boolean
  /** Account lockout after N failed login attempts. */
  lockout?: LockoutConfig
}

// ── Top-level relations (Phase 0) ─────────────────────────────────────────────

export type SpecRelationType = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'

export interface SpecRelation {
  /** Name of the source resource (must exist in spec.resources). */
  from: string
  /** Name of the target resource (must exist in spec.resources). */
  to: string
  type: SpecRelationType
  /** Field name on the source side. */
  field: string
  /** Join table name — required for many-to-many. */
  through?: string
  onDelete?: 'cascade' | 'set-null' | 'restrict'
}

// ── Env declarations (Phase 0) ────────────────────────────────────────────────

export interface EnvVarDefinition {
  name: string
  required: boolean
  description?: string
  example?: string
  /** When true, ZeroAPI generates a random value at deploy. */
  generate?: boolean
  /** When true, ZeroAPI Cloud manages the secret. */
  managedByCloud?: boolean
}

// ── Permissions (Phase 0) ─────────────────────────────────────────────────────

export type PermissionAction = 'create' | 'read' | 'update' | 'delete'

export interface PermissionRule {
  role: string
  actions: PermissionAction[]
  /** Restrict the rule to rows owned by the requester. */
  ownOnly?: boolean
}

export interface PermissionDefinition {
  resource: string
  rules: PermissionRule[]
}

// ── Features (Phase 0) ────────────────────────────────────────────────────────

export interface FileUploadFeature {
  enabled: boolean
  provider: 's3' | 'r2' | 'local'
  maxSizeMB: number
  allowedTypes: string[]
}

export interface WebhooksFeature {
  outbound?: string[]
  inbound?: string[]
}

export interface SearchFeature {
  enabled: boolean
  fuzzy?: boolean
}

export interface RateLimitFeature {
  perKey?: string
  public?: string
}

export interface PaginationFeature {
  defaultLimit?: number
  maxLimit?: number
}

export interface FeaturesConfig {
  fileUpload?: FileUploadFeature
  webhooks?: WebhooksFeature
  search?: SearchFeature
  rateLimit?: RateLimitFeature
  pagination?: PaginationFeature
}

// ── Root spec ─────────────────────────────────────────────────────────────────

export interface ZeroAPISpec {
  version: string
  name: string
  description?: string
  baseUrl?: string
  auth?: GlobalAuthConfig
  roles?: RoleDefinition[]
  rateLimit?: RateLimitConfig
  cors?: CorsConfig
  security?: SecurityConfig
  resources: ResourceDefinition[]
  /** Chantier 5: mount auth registration/login/verification/reset endpoints. */
  authFlows?: AuthFlowsConfig
  /** Chantier 4: env var names that must be set at startup (validated by assertEnv). */
  requiredEnv?: string[]
  /** Phase 0: top-level relations across resources. */
  relations?: SpecRelation[]
  /** Phase 0: declared environment variables. */
  env?: EnvVarDefinition[]
  /** Phase 0: declarative role-based permissions. */
  permissions?: PermissionDefinition[]
  /** Phase 0: optional cross-cutting features (uploads, webhooks, search, ...). */
  features?: FeaturesConfig
}
