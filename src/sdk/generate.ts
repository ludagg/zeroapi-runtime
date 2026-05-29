import type {
  ZeroAPISpec, ResourceDefinition, FieldDefinition, FieldType, CrudAction,
} from '../types/spec.js'
import { toPlural } from '../utils/plural.js'

const DEFAULT_ENDPOINTS: CrudAction[] = ['list', 'create', 'read', 'update', 'delete']

// ── Naming helpers ────────────────────────────────────────────────────────────

/**
 * "shop-api" → "Shop"
 * "my_cool-api" → "MyCool"
 * "products" → "Products"
 * The "-api"/"_api" suffix is stripped so the generated class reads "ShopClient",
 * not "ShopApiClient".
 */
function deriveClassBase(apiName: string): string {
  const cleaned = apiName.replace(/[-_\s]?api$/i, '').trim() || apiName
  const parts = cleaned.split(/[-_\s]+/).filter(Boolean)
  if (parts.length === 0) return 'Api'
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('')
}

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function camel(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

// ── Type mapping ──────────────────────────────────────────────────────────────

const RESERVED_FIELDS = new Set(['id', 'createdAt', 'updatedAt'])

function fieldToTsType(field: FieldDefinition): string {
  switch (field.type as FieldType) {
    case 'string':
    case 'text':
    case 'email':
    case 'url':
    case 'uuid':
    case 'date':
    case 'datetime':
      return 'string'
    case 'number':
    case 'integer':
    case 'decimal':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'json':
      return 'unknown'
    case 'file':
      return 'string'
    case 'file[]':
      return 'string[]'
    case 'enum':
      if (field.values && field.values.length > 0) {
        return field.values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ')
      }
      return 'string'
    default:
      return 'unknown'
  }
}

// ── Resource type generators ──────────────────────────────────────────────────

interface NestedChildInfo {
  /** Child resource (the nested collection accessor on the parent). */
  child: ResourceDefinition
  /** Plural URL segment for the child. */
  childPlural: string
  /** FK field on the child that points back at the parent. */
  fkField: string
  /** Method-key used on the parent accessor (camel-case plural child name). */
  accessor: string
}

function fkForRelation(rel: { resource: string; field?: string }): string {
  return rel.field ?? `${rel.resource.toLowerCase()}Id`
}

/**
 * Collects nested-child accessors for a parent resource, mirroring the routes
 * generator's `collectNestedRelations`. Each entry produces a `parent.<child>.list/get/...`
 * method that calls `/parents/:parentId/children` on the API.
 */
function collectNestedChildren(parent: ResourceDefinition, spec: ZeroAPISpec): NestedChildInfo[] {
  const out: NestedChildInfo[] = []
  const seen = new Set<string>()

  // FK side: any child resource that declares a manyToOne/oneToOne back to this parent.
  for (const child of spec.resources) {
    for (const rel of child.relations ?? []) {
      if (rel.type !== 'manyToOne' && rel.type !== 'oneToOne') continue
      if (rel.resource !== parent.name) continue
      if (seen.has(child.name)) continue
      seen.add(child.name)
      out.push({
        child,
        childPlural: toPlural(child.name),
        fkField: fkForRelation(rel),
        accessor: camel(toPlural(child.name)),
      })
    }
  }

  // oneToMany side without an explicit reverse — fall back to conventional FK.
  for (const rel of parent.relations ?? []) {
    if (rel.type !== 'oneToMany') continue
    const child = spec.resources.find((r) => r.name === rel.resource)
    if (!child || seen.has(child.name)) continue
    const reverse = child.relations?.find(
      (r) => r.resource === parent.name && (r.type === 'manyToOne' || r.type === 'oneToOne'),
    )
    const fkField = reverse?.field ?? `${parent.name.toLowerCase()}Id`
    seen.add(child.name)
    out.push({
      child,
      childPlural: toPlural(child.name),
      fkField,
      accessor: camel(toPlural(child.name)),
    })
  }

  return out
}

function renderResourceTypes(resource: ResourceDefinition): string {
  const name = pascal(resource.name)
  const fullLines: string[] = ['  id: string']
  const createLines: string[] = []
  const updateLines: string[] = []

  if (resource.timestamps !== false) {
    fullLines.push('  createdAt: string')
    fullLines.push('  updatedAt: string')
  }
  if (resource.softDelete) {
    fullLines.push('  deletedAt?: string | null')
  }

  for (const [fieldName, field] of Object.entries(resource.fields)) {
    if (RESERVED_FIELDS.has(fieldName)) continue
    const tsType = fieldToTsType(field)
    const optional = field.required ? '' : '?'
    const desc = field.description ? `  /** ${field.description} */\n` : ''
    fullLines.push(`${desc}  ${fieldName}${optional}: ${tsType}`)
    createLines.push(`${desc}  ${fieldName}${optional}: ${tsType}`)
    updateLines.push(`${desc}  ${fieldName}?: ${tsType}`)
  }

  // Include FK fields declared on relations (manyToOne / oneToOne) so the
  // generated types reflect what the server actually stores and accepts.
  for (const rel of resource.relations ?? []) {
    if (rel.type !== 'manyToOne' && rel.type !== 'oneToOne') continue
    const fk = fkForRelation(rel)
    if (RESERVED_FIELDS.has(fk)) continue
    if (Object.prototype.hasOwnProperty.call(resource.fields, fk)) continue
    const optional = rel.required ? '' : '?'
    fullLines.push(`  ${fk}${optional}: string`)
    createLines.push(`  ${fk}${optional}: string`)
    updateLines.push(`  ${fk}?: string`)
  }

  const fullBlock = `export interface ${name} {\n${fullLines.join('\n')}\n}`
  const createBlock = `export interface Create${name}Input {\n${createLines.length > 0 ? createLines.join('\n') : '  // no client-settable fields'}\n}`
  const updateBlock = `export interface Update${name}Input {\n${updateLines.length > 0 ? updateLines.join('\n') : '  // no client-settable fields'}\n}`

  return [fullBlock, createBlock, updateBlock].join('\n\n')
}

// ── Resource accessor (one per resource) ──────────────────────────────────────

function renderResourceAccessor(
  resource: ResourceDefinition,
  spec: ZeroAPISpec,
  options: { asNested?: boolean } = {},
): string {
  const name = pascal(resource.name)
  const plural = toPlural(resource.name)
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const indent = options.asNested ? '      ' : '    '

  // When asNested, methods receive a parentId and target /<parentPlural>/${parentId}/<plural>
  // The `__parentPath__` placeholder is replaced at call sites below.
  const basePath = options.asNested ? '`${parentPath}/' + plural + '`' : "'/" + plural + "'"

  const methods: string[] = []

  if (endpoints.includes('list')) {
    methods.push(
      `${indent}list: (${options.asNested ? 'parentId: string, ' : ''}params?: ListParams<${name}>): Promise<ListResult<${name}>> => {\n` +
      `${indent}  ${options.asNested ? `const parentPath = \`/__PARENT_PLURAL__/\${encodeURIComponent(parentId)}\`\n${indent}  ` : ''}return this.request<ListResult<${name}>>('GET', ${basePath}, undefined, paramsToQuery(params))\n` +
      `${indent}},`
    )
  }

  if (endpoints.includes('read')) {
    methods.push(
      `${indent}get: (${options.asNested ? 'parentId: string, ' : ''}id: string, opts?: { include?: string[] }): Promise<${name}> => {\n` +
      `${indent}  ${options.asNested ? `const parentPath = \`/__PARENT_PLURAL__/\${encodeURIComponent(parentId)}\`\n${indent}  ` : ''}return this.request<{ data: ${name} }>('GET', ${options.asNested ? '`${parentPath}/' + plural + '/${encodeURIComponent(id)}`' : '`/' + plural + '/${encodeURIComponent(id)}`'}, undefined, opts?.include?.length ? { include: opts.include.join(',') } : undefined).then((r) => r.data)\n` +
      `${indent}},`
    )
  }

  if (endpoints.includes('create')) {
    methods.push(
      `${indent}create: (${options.asNested ? 'parentId: string, ' : ''}input: Create${name}Input): Promise<${name}> => {\n` +
      `${indent}  ${options.asNested ? `const parentPath = \`/__PARENT_PLURAL__/\${encodeURIComponent(parentId)}\`\n${indent}  ` : ''}return this.request<{ data: ${name} }>('POST', ${basePath}, input).then((r) => r.data)\n` +
      `${indent}},`
    )
  }

  if (endpoints.includes('update')) {
    methods.push(
      `${indent}update: (${options.asNested ? 'parentId: string, ' : ''}id: string, input: Update${name}Input): Promise<${name}> => {\n` +
      `${indent}  ${options.asNested ? `const parentPath = \`/__PARENT_PLURAL__/\${encodeURIComponent(parentId)}\`\n${indent}  ` : ''}return this.request<{ data: ${name} }>('PUT', ${options.asNested ? '`${parentPath}/' + plural + '/${encodeURIComponent(id)}`' : '`/' + plural + '/${encodeURIComponent(id)}`'}, input).then((r) => r.data)\n` +
      `${indent}},`
    )
  }

  if (endpoints.includes('delete')) {
    methods.push(
      `${indent}delete: (${options.asNested ? 'parentId: string, ' : ''}id: string): Promise<void> => {\n` +
      `${indent}  ${options.asNested ? `const parentPath = \`/__PARENT_PLURAL__/\${encodeURIComponent(parentId)}\`\n${indent}  ` : ''}return this.request<void>('DELETE', ${options.asNested ? '`${parentPath}/' + plural + '/${encodeURIComponent(id)}`' : '`/' + plural + '/${encodeURIComponent(id)}`'})\n` +
      `${indent}},`
    )
  }

  // Nested accessors on top-level resource only.
  if (!options.asNested) {
    const children = collectNestedChildren(resource, spec)
    for (const info of children) {
      const childAccessor = renderResourceAccessor(info.child, spec, { asNested: true })
        .replace(/__PARENT_PLURAL__/g, toPlural(resource.name))
      methods.push(`${indent}${info.accessor}: {\n${childAccessor}\n${indent}},`)
    }
  }

  return methods.join('\n')
}

// ── Auth methods ──────────────────────────────────────────────────────────────

function isJwtEnabled(spec: ZeroAPISpec): boolean {
  return spec.auth?.jwt?.enabled === true
}

function renderAuthBlock(): string {
  return `  auth = {
    register: (input: { email: string; password: string }): Promise<AuthResult> => {
      return this.request<AuthResult>('POST', '/auth/register', input).then((r) => {
        if (r?.accessToken) this.setToken(r.accessToken)
        return r
      })
    },
    login: (input: { email: string; password: string }): Promise<AuthResult> => {
      return this.request<AuthResult>('POST', '/auth/login', input).then((r) => {
        if (r?.accessToken) this.setToken(r.accessToken)
        return r
      })
    },
    refresh: (refreshToken: string): Promise<AuthResult> => {
      return this.request<AuthResult>('POST', '/auth/refresh', { refreshToken }).then((r) => {
        if (r?.accessToken) this.setToken(r.accessToken)
        return r
      })
    },
    logout: (refreshToken?: string): Promise<void> => {
      const result = this.request<void>('POST', '/auth/logout', refreshToken ? { refreshToken } : undefined)
      this.setToken(undefined)
      return result
    },
    me: <T = unknown>(): Promise<T> => {
      return this.request<{ data: T } | T>('GET', '/auth/me').then((r) => {
        if (r && typeof r === 'object' && 'data' in (r as object)) return (r as { data: T }).data
        return r as T
      })
    },
  }`
}

// ── Upload methods ────────────────────────────────────────────────────────────

function isUploadEnabled(spec: ZeroAPISpec): boolean {
  if (spec.features?.fileUpload?.enabled) return true
  for (const r of spec.resources) {
    for (const f of Object.values(r.fields)) {
      if (f.type === 'file' || f.type === 'file[]') return true
    }
  }
  return false
}

function renderUploadMethod(): string {
  return `  /** Upload a file via multipart/form-data. Returns the stored URL. */
  upload(file: File | Blob, fieldName: string = 'file'): Promise<{ url: string; key?: string }> {
    const formData = new FormData()
    formData.append(fieldName, file)
    return this.request<{ url: string; key?: string }>('POST', '/upload', formData)
  }
`
}

// ── Main entrypoint ───────────────────────────────────────────────────────────

/**
 * Generates a complete, autonomous TypeScript SDK file (client.ts) for the
 * given Spec. The output has zero external dependencies, uses the native
 * `fetch`, and runs in browsers, Node 18+, and React Native.
 *
 * The class name is derived from the API name: "shop-api" → "ShopClient".
 */
export function generateSdk(spec: ZeroAPISpec): string {
  const classBase = deriveClassBase(spec.name)
  const className = `${classBase}Client`
  const jwt = isJwtEnabled(spec)
  const upload = isUploadEnabled(spec)

  const typeBlocks = spec.resources.map(renderResourceTypes).join('\n\n')
  const resourceAccessors = spec.resources
    .map((r) => {
      const accessorName = camel(toPlural(r.name))
      const body = renderResourceAccessor(r, spec)
      return `  ${accessorName} = {\n${body}\n  }`
    })
    .join('\n\n')

  const authMember = jwt ? `\n${renderAuthBlock()}` : ''
  const uploadMember = upload ? `\n${renderUploadMethod()}` : ''

  const baseUrlComment = spec.baseUrl ? ` (default: ${spec.baseUrl})` : ''
  const defaultBase = spec.baseUrl ? ` ?? '${spec.baseUrl}'` : ''

  return `// SDK généré par ZeroAPI pour ${spec.name}
// Copie ce fichier dans ton projet et importe ${className}
// Spec: ${spec.name} v${spec.version}
// Aucune dépendance externe — utilise fetch natif (navigateur, Node 18+, React Native).

// ── Types ─────────────────────────────────────────────────────────────────────

${typeBlocks}

export interface PaginationMeta {
  page?: number
  limit?: number
  total?: number
  totalPages?: number
}

export interface ListResult<T> {
  data: T[]
  count?: number
  pagination?: PaginationMeta
  nextCursor?: string
}

export type FilterValue = string | number | boolean | null
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'like' | 'ilike'

/**
 * Type-safe query parameters for list endpoints.
 * - field filters: \`{ status: 'active' }\` or \`{ price: { gte: 10, lte: 100 } }\`
 * - free-text search: \`q\`
 * - sort: \`'createdAt'\` or \`'-createdAt'\` (descending)
 * - pagination: \`page\` + \`limit\`, or cursor-based via response
 * - relation expansion: \`include\`
 */
export type ListParams<T> = {
  [K in keyof T]?: FilterValue | Partial<Record<FilterOperator, FilterValue | FilterValue[]>>
} & {
  q?: string
  sort?: string | string[]
  page?: number
  limit?: number
  include?: string[]
}

${jwt ? `export interface AuthResult {
  accessToken?: string
  refreshToken?: string
  user?: unknown
  [key: string]: unknown
}

` : ''}// ── Error ─────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? \`API request failed with status \${status}\`)
    this.name = 'ApiError'
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function paramsToQuery(params?: Record<string, unknown>): Record<string, string> | undefined {
  if (!params) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (key === 'include' && Array.isArray(value)) {
      out.include = value.join(',')
      continue
    }
    if (key === 'sort') {
      out.sort = Array.isArray(value) ? value.join(',') : String(value)
      continue
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Operator object: { gte: 10, lte: 100 } → ?field[gte]=10&field[lte]=100
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        if (opValue === undefined || opValue === null) continue
        const v = Array.isArray(opValue) ? opValue.join(',') : String(opValue)
        out[\`\${key}[\${op}]\`] = v
      }
      continue
    }
    if (Array.isArray(value)) {
      out[key] = value.join(',')
      continue
    }
    out[key] = String(value)
  }
  return out
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface ${className}Config {
  /** Base URL of the API (no trailing slash).${baseUrlComment} */
  baseUrl?: string
  /** API key — sent as \`X-API-Key\` header. */
  apiKey?: string
  /** Bearer / JWT token — sent as \`Authorization: Bearer <token>\`. */
  token?: string
  /** Optional custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch
  /** Optional extra headers applied to every request. */
  headers?: Record<string, string>
}

export class ${className} {
  private baseUrl: string
  private apiKey?: string
  private token?: string
  private fetchImpl: typeof fetch
  private extraHeaders: Record<string, string>

  constructor(config: ${className}Config = {}) {
    this.baseUrl = (config.baseUrl${defaultBase} ?? '').replace(/\\/+$/, '')
    if (config.apiKey !== undefined) this.apiKey = config.apiKey
    if (config.token !== undefined) this.token = config.token
    this.fetchImpl = config.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => {
      throw new Error('No fetch implementation available — pass one via config.fetch')
    }) as typeof fetch)
    this.extraHeaders = config.headers ?? {}
  }

  /** Replace the bearer token used for subsequent requests. */
  setToken(token: string | undefined): void {
    this.token = token
  }

  /** Replace the API key used for subsequent requests. */
  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    let url = this.baseUrl + path
    if (query && Object.keys(query).length > 0) {
      const usp = new URLSearchParams(query)
      url += (url.includes('?') ? '&' : '?') + usp.toString()
    }

    const headers: Record<string, string> = { ...this.extraHeaders }
    if (this.apiKey) headers['X-API-Key'] = this.apiKey
    if (this.token) headers['Authorization'] = \`Bearer \${this.token}\`

    let payload: BodyInit | undefined
    if (body !== undefined) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        payload = body
      } else {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
        payload = JSON.stringify(body)
      }
    }

    const init: RequestInit = { method, headers }
    if (payload !== undefined) init.body = payload

    const res = await this.fetchImpl(url, init)
    if (!res.ok) {
      let errBody: unknown
      try { errBody = await res.json() } catch { errBody = await res.text().catch(() => null) }
      throw new ApiError(res.status, errBody)
    }

    if (res.status === 204) return undefined as T
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) return undefined as T
    return res.json() as Promise<T>
  }

${resourceAccessors}${authMember}${uploadMember}
}
`
}
