/**
 * Supported primitive field types in the ZeroAPI DSL.
 */
export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'email'
  | 'url'
  | 'uuid'

/**
 * Definition of a single resource field.
 */
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
}

/** Standard CRUD actions that can be enabled per resource. */
export type CrudAction = 'list' | 'create' | 'read' | 'update' | 'delete'

/** Per-resource authentication requirement. */
export interface AuthConfig {
  required: boolean
  roles?: string[]
  strategy?: 'jwt' | 'apikey' | 'bearer'
}

/** Before/after hook function names for a lifecycle event. */
export interface HookConfig {
  before?: string
  after?: string
}

/** Lifecycle hooks per CRUD operation on a resource. */
export interface ResourceHooks {
  list?: HookConfig
  create?: HookConfig
  read?: HookConfig
  update?: HookConfig
  delete?: HookConfig
}

/**
 * Role-based access control per resource action.
 * Each array holds the role names allowed for that action.
 * An empty or absent config means all authenticated users are allowed.
 */
export interface ResourceRBAC {
  /** Roles allowed to list and get by id. */
  read?: string[]
  /** Roles allowed to create and update. */
  write?: string[]
  /** Roles allowed to delete. */
  delete?: string[]
}

/**
 * A single API resource — maps to a Prisma model, Hono routes, and Zod schemas.
 */
export interface ResourceDefinition {
  name: string
  description?: string
  fields: Record<string, FieldDefinition>
  /** Defaults to all five CRUD actions when omitted. */
  endpoints?: CrudAction[]
  auth?: AuthConfig
  hooks?: ResourceHooks
  /** Optional RBAC — restricts actions to specific roles. */
  rbac?: ResourceRBAC
}

/** Global authentication configuration applied across the whole API. */
export interface GlobalAuthConfig {
  strategy: 'jwt' | 'apikey' | 'bearer'
  /** Used for JWT signature verification. */
  secret?: string
  /** Custom header name. Defaults to "Authorization". */
  header?: string
}

/**
 * A named role with optional inheritance.
 * Permissions are defined on each resource via `ResourceDefinition.rbac`.
 */
export interface RoleDefinition {
  name: string
  description?: string
  /** Roles whose permissions this role inherits. */
  inherits?: string[]
}

/** Rate-limiting configuration applied globally. */
export interface RateLimitConfig {
  /** Duration of the sliding window in milliseconds. */
  windowMs: number
  /** Maximum number of requests per IP per window. */
  max: number
  /** Also apply a per-user limit (extracted from JWT `sub`). */
  byUser?: boolean
  /** Custom rejection message. */
  message?: string
}

/** Configurable CORS policy. When absent, permissive defaults apply. */
export interface CorsConfig {
  origins: string[]
  methods?: string[]
  headers?: string[]
  credentials?: boolean
}

/** Security-header (Helmet-style) configuration. All defaults are on. */
export interface SecurityConfig {
  contentSecurityPolicy?: boolean
  hsts?: boolean
  noSniff?: boolean
  frameguard?: boolean | 'DENY' | 'SAMEORIGIN'
  xssProtection?: boolean
  referrerPolicy?: string
}

/**
 * Root ZeroAPI Spec — the contract between the AI generator and the runtime.
 */
export interface ZeroAPISpec {
  version: string
  name: string
  description?: string
  baseUrl?: string
  /** Global authentication applied to resources that set `auth.required = true`. */
  auth?: GlobalAuthConfig
  /** Named roles available across all resources. */
  roles?: RoleDefinition[]
  /** Global rate limiting (applied before route handlers). */
  rateLimit?: RateLimitConfig
  /** Configurable CORS policy (overrides the default permissive CORS). */
  cors?: CorsConfig
  /** Security headers configuration. */
  security?: SecurityConfig
  resources: ResourceDefinition[]
}
