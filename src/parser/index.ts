import { z } from 'zod'
import type { ZeroAPISpec, ResourceDefinition } from '../types/spec.js'

// ── Field ─────────────────────────────────────────────────────────────────────

const FieldTypeSchema = z.enum([
  'string', 'text', 'number', 'integer', 'decimal', 'boolean',
  'date', 'datetime', 'email', 'url', 'uuid',
  'file', 'file[]',
  'json', 'enum',
])

const FieldDefinitionSchema = z.object({
  type: FieldTypeSchema,
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  index: z.boolean().optional(),
  default: z.any().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  description: z.string().optional(),
  values: z.array(z.string()).optional(),
  // file-specific
  accept: z.array(z.string()).optional(),
  maxSize: z.string().optional(),
  storage: z.enum(['r2', 's3', 'local']).optional(),
  multiple: z.boolean().optional(),
})

// ── Resource ──────────────────────────────────────────────────────────────────

const CrudActionSchema = z.enum(['list', 'create', 'read', 'update', 'delete'])

const AuthConfigSchema = z.object({
  required: z.boolean(),
  roles: z.array(z.string()).optional(),
  strategy: z.enum(['jwt', 'apikey', 'bearer']).optional(),
})

const HookConfigSchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
})

const ResourceHooksSchema = z.object({
  list: HookConfigSchema.optional(),
  create: HookConfigSchema.optional(),
  read: HookConfigSchema.optional(),
  update: HookConfigSchema.optional(),
  delete: HookConfigSchema.optional(),
})

const ResourceRBACSchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
  delete: z.array(z.string()).optional(),
})

// Relations (per-resource, legacy)
const RelationDefinitionSchema = z.object({
  type: z.enum(['oneToOne', 'oneToMany', 'manyToOne', 'manyToMany']),
  resource: z.string().min(1),
  field: z.string().optional(),
  required: z.boolean().optional(),
  through: z.string().optional(),
  fields: z.record(z.string(), FieldDefinitionSchema).optional(),
  onDelete: z.enum(['Cascade', 'SetNull', 'Restrict', 'NoAction']).optional(),
})

// Transactions
const TxOperationSchema = z.object({
  action: z.enum(['create', 'update', 'delete', 'decrement', 'increment']),
  resource: z.string().min(1),
  idFrom: z.string().optional(),
  field: z.string().optional(),
  amount: z.number().optional(),
  amountFrom: z.string().optional(),
})

const TransactionConfigSchema = z.object({
  trigger: z.enum(['POST', 'PUT', 'DELETE', 'PATCH']),
  operations: z.array(TxOperationSchema).min(1),
})

const ResourceDefinitionSchema = z.object({
  name: z.string().min(1, 'Resource name cannot be empty'),
  description: z.string().optional(),
  fields: z.record(z.string(), FieldDefinitionSchema).refine(
    (f) => Object.keys(f).length > 0,
    'Resource must define at least one field'
  ),
  endpoints: z.array(CrudActionSchema).optional(),
  auth: AuthConfigSchema.optional(),
  hooks: ResourceHooksSchema.optional(),
  rbac: ResourceRBACSchema.optional(),
  relations: z.array(RelationDefinitionSchema).optional(),
  transactions: z.array(TransactionConfigSchema).optional(),
  softDelete: z.boolean().optional(),
  timestamps: z.boolean().optional(),
  searchable: z.array(z.string()).optional(),
})

// ── Global config ─────────────────────────────────────────────────────────────

const JwtAuthConfigSchema = z.object({
  enabled: z.boolean().optional(),
  accessTokenTTL: z.string().optional(),
  refreshTokenTTL: z.string().optional(),
  secretEnv: z.string().optional(),
})

const ApiKeyAuthConfigSchema = z.object({
  enabled: z.boolean(),
  header: z.string().optional(),
  prefix: z.string().optional(),
})

const OAuthProviderConfigSchema = z.object({
  name: z.enum(['google', 'apple', 'github']),
  clientIdEnv: z.string().min(1),
  clientSecretEnv: z.string().min(1),
  scopes: z.array(z.string()).optional(),
})

const OAuthConfigSchema = z.object({
  providers: z.array(OAuthProviderConfigSchema).min(1),
})

const GlobalAuthConfigSchema = z.object({
  // Modern shape (all optional so the legacy shape remains valid)
  enabled: z.boolean().optional(),
  strategies: z.array(z.enum(['jwt', 'apikey', 'oauth'])).optional(),
  jwt: JwtAuthConfigSchema.optional(),
  apikey: ApiKeyAuthConfigSchema.optional(),
  oauth: OAuthConfigSchema.optional(),
  emailVerification: z.boolean().optional(),
  passwordReset: z.boolean().optional(),
  // Legacy shape
  strategy: z.enum(['jwt', 'apikey', 'bearer']).optional(),
  secret: z.string().optional(),
  header: z.string().optional(),
})

const RoleDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inherits: z.array(z.string()).optional(),
})

const RateLimitConfigSchema = z.object({
  windowMs: z.number().int().positive(),
  max: z.number().int().positive(),
  byUser: z.boolean().optional(),
  message: z.string().optional(),
})

const CorsConfigSchema = z.object({
  origins: z.array(z.string()).min(1),
  methods: z.array(z.string()).optional(),
  headers: z.array(z.string()).optional(),
  credentials: z.boolean().optional(),
})

const SecurityConfigSchema = z.object({
  contentSecurityPolicy: z.boolean().optional(),
  hsts: z.boolean().optional(),
  noSniff: z.boolean().optional(),
  frameguard: z.union([z.boolean(), z.enum(['DENY', 'SAMEORIGIN'])]).optional(),
  xssProtection: z.boolean().optional(),
  referrerPolicy: z.string().optional(),
})

// ── Phase 0: new optional top-level blocks ────────────────────────────────────

const SpecRelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']),
  field: z.string().min(1),
  through: z.string().optional(),
  onDelete: z.enum(['cascade', 'set-null', 'restrict']).optional(),
})

const EnvVarDefinitionSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  description: z.string().optional(),
  example: z.string().optional(),
  generate: z.boolean().optional(),
  managedByCloud: z.boolean().optional(),
})

const PermissionRuleSchema = z.object({
  role: z.string().min(1),
  actions: z.array(z.enum(['create', 'read', 'update', 'delete'])).min(1),
  ownOnly: z.boolean().optional(),
})

const PermissionDefinitionSchema = z.object({
  resource: z.string().min(1),
  rules: z.array(PermissionRuleSchema).min(1),
})

const FileUploadFeatureSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['s3', 'r2', 'local']),
  maxSizeMB: z.number().positive(),
  allowedTypes: z.array(z.string()),
})

const WebhooksFeatureSchema = z.object({
  outbound: z.array(z.string()).optional(),
  inbound: z.array(z.string()).optional(),
})

const SearchFeatureSchema = z.object({
  enabled: z.boolean(),
  fuzzy: z.boolean().optional(),
})

const RateLimitFeatureSchema = z.object({
  perKey: z.string().optional(),
  public: z.string().optional(),
})

const PaginationFeatureSchema = z.object({
  defaultLimit: z.number().int().positive().optional(),
  maxLimit: z.number().int().positive().optional(),
})

const FeaturesConfigSchema = z.object({
  fileUpload: FileUploadFeatureSchema.optional(),
  webhooks: WebhooksFeatureSchema.optional(),
  search: SearchFeatureSchema.optional(),
  rateLimit: RateLimitFeatureSchema.optional(),
  pagination: PaginationFeatureSchema.optional(),
})

// ── Root ──────────────────────────────────────────────────────────────────────

const ZeroAPISpecSchema = z.object({
  version: z.string().min(1, 'Version is required'),
  name: z.string().min(1, 'Spec name is required'),
  description: z.string().optional(),
  baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  auth: GlobalAuthConfigSchema.optional(),
  roles: z.array(RoleDefinitionSchema).optional(),
  rateLimit: RateLimitConfigSchema.optional(),
  cors: CorsConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
  resources: z.array(ResourceDefinitionSchema).min(1, 'Spec must define at least one resource'),
  authFlows: z.object({
    emailVerification: z.boolean().optional(),
    passwordReset: z.boolean().optional(),
    refreshTokens: z.boolean().optional(),
    revocation: z.boolean().optional(),
    lockout: z.object({
      maxAttempts: z.number().int().positive(),
      windowMs: z.number().int().positive(),
    }).optional(),
  }).optional(),
  requiredEnv: z.array(z.string()).optional(),
  relations: z.array(SpecRelationSchema).optional(),
  env: z.array(EnvVarDefinitionSchema).optional(),
  permissions: z.array(PermissionDefinitionSchema).optional(),
  features: FeaturesConfigSchema.optional(),
})

// ── Relation semantic validation ──────────────────────────────────────────────

function validateRelations(resources: ResourceDefinition[]): string | null {
  const names = new Set(resources.map((r) => r.name))
  const throughNames = new Set<string>()

  for (const resource of resources) {
    for (const rel of resource.relations ?? []) {
      if (!names.has(rel.resource)) {
        return `Resource "${resource.name}" has relation to unknown resource "${rel.resource}"`
      }
      if (rel.type === 'manyToMany' && !rel.through) {
        return `manyToMany relation in "${resource.name}" → "${rel.resource}" requires a "through" field`
      }
      if (rel.through) {
        if (throughNames.has(rel.through)) {
          return `Duplicate join-table name "${rel.through}" — each manyToMany must use a unique through name`
        }
        throughNames.add(rel.through)
      }
    }
  }

  // Detect mutual required manyToOne (insertion deadlock)
  for (const resource of resources) {
    for (const rel of resource.relations ?? []) {
      if (rel.type !== 'manyToOne' || !rel.required) continue
      const target = resources.find((r) => r.name === rel.resource)
      const reverse = target?.relations?.find(
        (r) => r.resource === resource.name && r.type === 'manyToOne' && r.required
      )
      if (reverse) {
        return `Circular required manyToOne: "${resource.name}" ↔ "${rel.resource}" creates an insertion deadlock`
      }
    }
  }

  return null
}

function validateSpecLevelBlocks(spec: ZeroAPISpec): string | null {
  const names = new Set(spec.resources.map((r) => r.name))

  for (const rel of spec.relations ?? []) {
    if (!names.has(rel.from)) {
      return `Top-level relation references unknown resource "${rel.from}" in "from"`
    }
    if (!names.has(rel.to)) {
      return `Top-level relation "${rel.from}" → "${rel.to}" references unknown resource "${rel.to}"`
    }
    if (rel.type === 'many-to-many' && !rel.through) {
      return `Top-level many-to-many relation "${rel.from}" → "${rel.to}" requires a "through" field`
    }
  }

  const jwtEnabled = spec.auth?.jwt?.enabled === true
  for (const perm of spec.permissions ?? []) {
    if (!names.has(perm.resource)) {
      return `Permission rule references unknown resource "${perm.resource}"`
    }
    for (const rule of perm.rules) {
      if (rule.ownOnly) {
        if (rule.role === 'public') {
          return `Permission rule on "${perm.resource}" uses ownOnly with role "public" — public requesters have no identity to own rows`
        }
        if (!jwtEnabled) {
          return `Permission rule on "${perm.resource}" uses ownOnly but auth.jwt.enabled is not true — ownOnly requires authenticated users`
        }
      }
    }
  }

  // Phase 1.2: when JWT user system is on, "User" and "RefreshToken" are reserved
  if (spec.auth?.jwt?.enabled === true) {
    for (const reserved of ['User', 'RefreshToken']) {
      if (names.has(reserved)) {
        return `Resource name "${reserved}" is reserved when auth.jwt.enabled is true — rename the resource or disable auth.jwt`
      }
    }
  }

  return null
}

// ── Public API ────────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly details: z.ZodError
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

/**
 * Parses and validates a raw object against the ZeroAPI DSL schema.
 * Performs structural validation (Zod) followed by semantic checks
 * (per-resource relation integrity + top-level relations/permissions).
 * Throws ParseError with field-level details on failure.
 */
export function parseSpec(raw: unknown): ZeroAPISpec {
  const result = ZeroAPISpecSchema.safeParse(raw)
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join(' | ')
    throw new ParseError(`Invalid ZeroAPI spec — ${summary}`, result.error)
  }

  const spec = result.data as ZeroAPISpec
  const relError = validateRelations(spec.resources)
  if (relError) {
    const relZodError = new z.ZodError([
      { code: z.ZodIssueCode.custom, message: relError, path: ['resources'] },
    ])
    throw new ParseError(`Invalid ZeroAPI spec — ${relError}`, relZodError)
  }

  const topLevelError = validateSpecLevelBlocks(spec)
  if (topLevelError) {
    const zodError = new z.ZodError([
      { code: z.ZodIssueCode.custom, message: topLevelError, path: [] },
    ])
    throw new ParseError(`Invalid ZeroAPI spec — ${topLevelError}`, zodError)
  }

  return spec
}
