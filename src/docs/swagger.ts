import type {
  ZeroAPISpec,
  ResourceDefinition,
  FieldDefinition,
  FieldType,
  CrudAction,
} from '../types/spec.js'
import { toPlural } from '../utils/plural.js'
import { buildAuthPaths, buildAuthSchemas, buildAuthTags } from './auth-openapi.js'

// ── JSON Schema types (subset used for OpenAPI 3.0) ───────────────────────────

export interface JSONSchema {
  type?: string
  format?: string
  description?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  enum?: unknown[]
  nullable?: boolean
  default?: unknown
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  readOnly?: boolean
}

export interface OpenAPIInfo {
  title: string
  version: string
  description?: string
}

export interface OpenAPIServer {
  url: string
  description?: string
}

export interface OpenAPISpec {
  openapi: '3.0.3'
  info: OpenAPIInfo
  servers?: OpenAPIServer[]
  paths: Record<string, Record<string, unknown>>
  components: {
    schemas: Record<string, JSONSchema>
    securitySchemes?: Record<string, unknown>
  }
  security?: Array<Record<string, string[]>>
  tags?: Array<{ name: string; description?: string }>
}

// ── Field mapping ─────────────────────────────────────────────────────────────

const TYPE_MAP: Record<FieldType, JSONSchema> = {
  string:    { type: 'string' },
  text:      { type: 'string' },
  number:    { type: 'number' },
  integer:   { type: 'integer' },
  decimal:   { type: 'number' },
  boolean:   { type: 'boolean' },
  date:      { type: 'string', format: 'date' },
  datetime:  { type: 'string', format: 'date-time' },
  email:     { type: 'string', format: 'email' },
  url:       { type: 'string', format: 'uri' },
  uuid:      { type: 'string', format: 'uuid' },
  file:      { type: 'string', format: 'uri', description: 'URL of the uploaded file' },
  // OpenAPI 3.0 requires `items` on every array schema — without it the doc is
  // invalid. File lists are stored as URL strings.
  'file[]':  { type: 'array', items: { type: 'string', format: 'uri' }, description: 'List of uploaded file URLs' },
  json:      { type: 'object' },
  enum:      { type: 'string' },
}

function fieldToJsonSchema(field: FieldDefinition): JSONSchema {
  const base: JSONSchema = { ...TYPE_MAP[field.type] }
  // Deep-copy nested `items` so callers never share the TYPE_MAP reference.
  if (base.items) base.items = { ...base.items }
  if (field.description) base.description = field.description
  if (field.default !== undefined && field.default !== null) base.default = field.default
  if (field.min !== undefined) base.minimum = field.min
  if (field.max !== undefined) base.maximum = field.max
  if (field.minLength !== undefined) base.minLength = field.minLength
  if (field.maxLength !== undefined) base.maxLength = field.maxLength
  // Surface enum members so clients get a closed set instead of a bare string.
  if (field.type === 'enum' && field.values && field.values.length > 0) {
    base.enum = [...field.values]
  }
  return base
}

// ── Schema builders ───────────────────────────────────────────────────────────

// Server-managed fields: omitted from create/update request bodies because they
// are auto-generated on create and re-issued on update.
const RESERVED_FIELDS = new Set(['id', 'createdAt', 'updatedAt'])

function buildFullSchema(resource: ResourceDefinition): JSONSchema {
  const props: Record<string, JSONSchema> = {
    id:        { type: 'string', format: 'uuid', readOnly: true },
    createdAt: { type: 'string', format: 'date-time', readOnly: true },
    updatedAt: { type: 'string', format: 'date-time', readOnly: true },
  }
  for (const [name, field] of Object.entries(resource.fields)) {
    if (RESERVED_FIELDS.has(name)) continue
    props[name] = fieldToJsonSchema(field)
  }
  return {
    type: 'object',
    description: resource.description,
    properties: props,
    required: ['id', 'createdAt', 'updatedAt'],
  }
}

function buildCreateSchema(resource: ResourceDefinition): JSONSchema {
  const props: Record<string, JSONSchema> = {}
  const required: string[] = []
  for (const [name, field] of Object.entries(resource.fields)) {
    if (RESERVED_FIELDS.has(name)) continue
    props[name] = fieldToJsonSchema(field)
    if (field.required) required.push(name)
  }
  return { type: 'object', properties: props, required: required.length ? required : undefined }
}

function buildUpdateSchema(resource: ResourceDefinition): JSONSchema {
  const props: Record<string, JSONSchema> = {}
  for (const [name, field] of Object.entries(resource.fields)) {
    if (RESERVED_FIELDS.has(name)) continue
    props[name] = fieldToJsonSchema(field)
  }
  return { type: 'object', properties: props }
}

// ── Response wrappers ─────────────────────────────────────────────────────────

function listResponse(schemaRef: string): unknown {
  return {
    description: 'OK',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: schemaRef } },
            count: { type: 'integer' },
          },
          required: ['data', 'count'],
        },
      },
    },
  }
}

function itemResponse(schemaRef: string, status = 200): unknown {
  return {
    description: status === 201 ? 'Created' : 'OK',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { data: { $ref: schemaRef } },
          required: ['data'],
        },
      },
    },
  }
}

function errorResponse(description: string): unknown {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
      },
    },
  }
}

// ── Path builders ─────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINTS: CrudAction[] = ['list', 'create', 'read', 'update', 'delete']



function buildPaths(
  resource: ResourceDefinition,
  security: Array<Record<string, string[]>> | undefined,
): Record<string, Record<string, unknown>> {
  const plural = toPlural(resource.name)
  const tag = resource.name
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const fullRef = `#/components/schemas/${resource.name}`
  const createRef = `#/components/schemas/Create${resource.name}`
  const updateRef = `#/components/schemas/Update${resource.name}`

  const collectionPath: Record<string, unknown> = {}
  const itemPath: Record<string, unknown> = {}

  if (endpoints.includes('list')) {
    collectionPath['get'] = {
      tags: [tag],
      summary: `List ${plural}`,
      operationId: `list${resource.name}s`,
      security,
      parameters: [
        { name: 'limit',  in: 'query', schema: { type: 'integer', default: 20 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', default: 0  } },
      ],
      responses: {
        '200': listResponse(fullRef),
        '401': errorResponse('Unauthorized'),
      },
    }
  }

  if (endpoints.includes('create')) {
    collectionPath['post'] = {
      tags: [tag],
      summary: `Create ${resource.name}`,
      operationId: `create${resource.name}`,
      security,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: createRef } } },
      },
      responses: {
        '201': itemResponse(fullRef, 201),
        '400': errorResponse('Bad Request'),
        '401': errorResponse('Unauthorized'),
        '422': errorResponse('Validation Error'),
      },
    }
  }

  if (endpoints.includes('read')) {
    itemPath['get'] = {
      tags: [tag],
      summary: `Get ${resource.name} by id`,
      operationId: `get${resource.name}ById`,
      security,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': itemResponse(fullRef),
        '401': errorResponse('Unauthorized'),
        '404': errorResponse('Not Found'),
      },
    }
  }

  if (endpoints.includes('update')) {
    itemPath['put'] = {
      tags: [tag],
      summary: `Update ${resource.name}`,
      operationId: `update${resource.name}`,
      security,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: updateRef } } },
      },
      responses: {
        '200': itemResponse(fullRef),
        '400': errorResponse('Bad Request'),
        '401': errorResponse('Unauthorized'),
        '404': errorResponse('Not Found'),
        '422': errorResponse('Validation Error'),
      },
    }
  }

  if (endpoints.includes('delete')) {
    itemPath['delete'] = {
      tags: [tag],
      summary: `Delete ${resource.name}`,
      operationId: `delete${resource.name}`,
      security,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { data: { nullable: true } } } } } },
        '401': errorResponse('Unauthorized'),
        '404': errorResponse('Not Found'),
      },
    }
  }

  const paths: Record<string, Record<string, unknown>> = {}
  if (Object.keys(collectionPath).length) paths[`/${plural}`] = collectionPath
  if (Object.keys(itemPath).length) paths[`/${plural}/{id}`] = itemPath
  return paths
}

// ── Security schemes ──────────────────────────────────────────────────────────

/**
 * Detects which auth schemes the spec activates, across BOTH the legacy
 * (`strategy`) and modern (`jwt.enabled` / `apikey.enabled` / `oauth`) shapes.
 * OAuth issues JWT bearer tokens, so it maps onto `bearerAuth`.
 */
function detectAuthSchemes(spec: ZeroAPISpec): { bearer: boolean; apiKey: boolean } {
  const auth = spec.auth
  if (!auth) return { bearer: false, apiKey: false }
  const bearer =
    auth.strategy === 'jwt' ||
    auth.strategy === 'bearer' ||
    auth.jwt?.enabled === true ||
    (auth.oauth?.providers?.length ?? 0) > 0
  const apiKey = auth.strategy === 'apikey' || auth.apikey?.enabled === true
  return { bearer, apiKey }
}

function buildSecuritySchemes(spec: ZeroAPISpec): Record<string, unknown> | undefined {
  const { bearer, apiKey } = detectAuthSchemes(spec)
  const schemes: Record<string, unknown> = {}
  if (bearer) schemes.bearerAuth = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
  if (apiKey) {
    schemes.apiKeyAuth = {
      type: 'apiKey',
      in: 'header',
      name: spec.auth?.apikey?.header ?? spec.auth?.header ?? 'X-API-Key',
    }
  }
  return Object.keys(schemes).length > 0 ? schemes : undefined
}

/**
 * Builds the OpenAPI `security` requirement list — only ever referencing schemes
 * that `buildSecuritySchemes` actually defines, so the document is never
 * internally inconsistent (a requirement naming an undefined scheme is invalid
 * per the OpenAPI spec). Multiple entries express OR semantics (any one works).
 */
function buildSecurityRequirement(
  spec: ZeroAPISpec,
): Array<Record<string, string[]>> | undefined {
  const { bearer, apiKey } = detectAuthSchemes(spec)
  const req: Array<Record<string, string[]>> = []
  if (bearer) req.push({ bearerAuth: [] })
  if (apiKey) req.push({ apiKeyAuth: [] })
  return req.length > 0 ? req : undefined
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates an OpenAPI 3.0.3 specification object from a ZeroAPI spec.
 * Suitable for serving as JSON at /openapi.json.
 */
export function generateOpenAPISpec(spec: ZeroAPISpec): OpenAPISpec {
  const schemas: Record<string, JSONSchema> = {}
  let paths: Record<string, Record<string, unknown>> = {}

  const securityRequirement = buildSecurityRequirement(spec)

  for (const resource of spec.resources) {
    schemas[resource.name] = buildFullSchema(resource)
    schemas[`Create${resource.name}`] = buildCreateSchema(resource)
    schemas[`Update${resource.name}`] = buildUpdateSchema(resource)
    paths = { ...paths, ...buildPaths(resource, securityRequirement) }
  }

  // Auth endpoints the runtime mounts automatically (register/login/refresh/
  // logout/me, OAuth, API-key admin). Emitted here so the doc + Playground show
  // clients how to obtain a token instead of advertising bearerAuth on every
  // path with no way to get one. Mirrors the mounting logic in createRuntime.
  paths = { ...paths, ...buildAuthPaths(spec) }
  Object.assign(schemas, buildAuthSchemas(spec))

  const servers: OpenAPIServer[] = [
    { url: spec.baseUrl ?? 'http://localhost:3000', description: 'API server' },
  ]

  const tags = [
    ...spec.resources.map((r) => ({ name: r.name, description: r.description })),
    ...buildAuthTags(spec),
  ]

  const securitySchemes = buildSecuritySchemes(spec)

  return {
    openapi: '3.0.3',
    info: { title: spec.name, version: spec.version, description: spec.description },
    servers,
    tags,
    paths,
    components: {
      schemas,
      ...(securitySchemes ? { securitySchemes } : {}),
    },
    ...(securityRequirement ? { security: securityRequirement } : {}),
  }
}
