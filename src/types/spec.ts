/** Supported primitive field types in the ZeroAPI DSL. */
export type FieldType =
  | 'string' | 'text' | 'number' | 'integer' | 'boolean'
  | 'date' | 'datetime' | 'email' | 'url' | 'uuid'
  | 'file'

/** Definition of a single resource field, including optional file-specific constraints. */
export interface FieldDefinition {
  type: FieldType
  required?: boolean
  unique?: boolean
  default?: string | number | boolean | null
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  description?: string
  // ── file-specific (only valid when type === 'file') ──────────────────────
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

// ── Relations ─────────────────────────────────────────────────────────────────

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
}

// ── Global config ─────────────────────────────────────────────────────────────

export interface GlobalAuthConfig {
  strategy: 'jwt' | 'apikey' | 'bearer'
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
}
