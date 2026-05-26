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

/**
 * Standard CRUD actions that can be enabled per resource.
 */
export type CrudAction = 'list' | 'create' | 'read' | 'update' | 'delete'

/**
 * Per-resource authentication configuration.
 */
export interface AuthConfig {
  required: boolean
  roles?: string[]
  strategy?: 'jwt' | 'apikey' | 'bearer'
}

/**
 * Before/after hook function names for a lifecycle event.
 */
export interface HookConfig {
  before?: string
  after?: string
}

/**
 * Lifecycle hooks per CRUD operation on a resource.
 */
export interface ResourceHooks {
  list?: HookConfig
  create?: HookConfig
  read?: HookConfig
  update?: HookConfig
  delete?: HookConfig
}

/**
 * A single API resource — maps to a Prisma model, a set of Hono routes, and Zod schemas.
 */
export interface ResourceDefinition {
  name: string
  description?: string
  fields: Record<string, FieldDefinition>
  /** Defaults to all five CRUD actions when omitted. */
  endpoints?: CrudAction[]
  auth?: AuthConfig
  hooks?: ResourceHooks
}

/**
 * Global authentication configuration applied to the whole API.
 */
export interface GlobalAuthConfig {
  strategy: 'jwt' | 'apikey' | 'bearer'
  /** Used for JWT signature verification. */
  secret?: string
  /** Custom header name. Defaults to "Authorization". */
  header?: string
}

/**
 * Root ZeroAPI Spec — the contract between the AI generator and the runtime.
 */
export interface ZeroAPISpec {
  version: string
  name: string
  description?: string
  baseUrl?: string
  auth?: GlobalAuthConfig
  resources: ResourceDefinition[]
}
