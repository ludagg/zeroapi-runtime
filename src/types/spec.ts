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

export interface HookConfig { before?: string; after?: string }

export interface ResourceHooks {
  list?: HookConfig; create?: HookConfig; read?: HookConfig
  update?: HookConfig; delete?: HookConfig
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
}
