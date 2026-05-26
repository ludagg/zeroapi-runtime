import { z } from 'zod'
import type { ZeroAPISpec, ResourceDefinition } from '../types/spec.js'

// ── Field ─────────────────────────────────────────────────────────────────────

const FieldTypeSchema = z.enum([
  'string', 'text', 'number', 'integer', 'boolean',
  'date', 'datetime', 'email', 'url', 'uuid', 'file',
])

const FieldDefinitionSchema = z.object({
  type: FieldTypeSchema,
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  description: z.string().optional(),
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

// Relations
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
})

// ── Global config ─────────────────────────────────────────────────────────────

const GlobalAuthConfigSchema = z.object({
  strategy: z.enum(['jwt', 'apikey', 'bearer']),
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
 * Performs structural validation (Zod) followed by semantic checks (relation integrity).
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

  return spec
}
