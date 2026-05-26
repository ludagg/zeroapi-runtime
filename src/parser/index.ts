import { z } from 'zod'
import type { ZeroAPISpec } from '../types/spec.js'

// ── Field ────────────────────────────────────────────────────────────────────

const FieldTypeSchema = z.enum([
  'string', 'text', 'number', 'integer', 'boolean',
  'date', 'datetime', 'email', 'url', 'uuid',
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
})

// ── Resource ─────────────────────────────────────────────────────────────────

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

// ── Root spec ─────────────────────────────────────────────────────────────────

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
 * Throws a ParseError with field-level details when the spec is invalid.
 */
export function parseSpec(raw: unknown): ZeroAPISpec {
  const result = ZeroAPISpecSchema.safeParse(raw)
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join(' | ')
    throw new ParseError(`Invalid ZeroAPI spec — ${summary}`, result.error)
  }
  return result.data as ZeroAPISpec
}
