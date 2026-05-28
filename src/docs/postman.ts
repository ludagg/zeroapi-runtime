import type {
  ZeroAPISpec,
  ResourceDefinition,
  FieldDefinition,
  FieldType,
  CrudAction,
  CustomEndpointDef,
  GlobalAuthConfig,
  SpecRelation,
} from '../types/spec.js'
import { toPlural } from '../utils/plural.js'

// ── Postman Collection v2.1 types ─────────────────────────────────────────────

export const POSTMAN_SCHEMA_V2_1 =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

export interface PostmanInfo {
  name: string
  description?: string
  schema: string
}

export interface PostmanVariable {
  key: string
  value: string
  type?: string
}

export interface PostmanAuthEntry {
  key: string
  value: string
  type: string
}

export interface PostmanAuth {
  type: 'bearer' | 'apikey' | 'noauth'
  bearer?: PostmanAuthEntry[]
  apikey?: PostmanAuthEntry[]
}

export interface PostmanHeader {
  key: string
  value: string
  type?: string
  disabled?: boolean
}

export interface PostmanQueryParam {
  key: string
  value: string
  disabled?: boolean
  description?: string
}

export interface PostmanUrlVariable {
  key: string
  value: string
}

export interface PostmanUrl {
  raw: string
  host: string[]
  path: string[]
  query?: PostmanQueryParam[]
  variable?: PostmanUrlVariable[]
}

export interface PostmanRawBody {
  mode: 'raw'
  raw: string
  options?: { raw: { language: 'json' | 'text' } }
}

export interface PostmanFormDataEntry {
  key: string
  type: 'text' | 'file'
  value?: string
  src?: string
  description?: string
}

export interface PostmanFormDataBody {
  mode: 'formdata'
  formdata: PostmanFormDataEntry[]
}

export type PostmanBody = PostmanRawBody | PostmanFormDataBody

export interface PostmanScript {
  type: 'text/javascript'
  exec: string[]
}

export interface PostmanEvent {
  listen: 'test' | 'prerequest'
  script: PostmanScript
}

export interface PostmanRequestNode {
  method: string
  header?: PostmanHeader[]
  body?: PostmanBody
  url: PostmanUrl
  description?: string
  auth?: PostmanAuth
}

export interface PostmanRequestItem {
  name: string
  request: PostmanRequestNode
  event?: PostmanEvent[]
  response?: unknown[]
}

export interface PostmanFolderItem {
  name: string
  description?: string
  item: PostmanItem[]
}

export type PostmanItem = PostmanRequestItem | PostmanFolderItem

export interface PostmanCollection {
  info: PostmanInfo
  variable: PostmanVariable[]
  auth?: PostmanAuth
  item: PostmanItem[]
}

// ── Auth detection (mirrors readme.ts) ────────────────────────────────────────

interface AuthFlags {
  jwt: boolean
  apikey: boolean
  oauth: boolean
  any: boolean
}

function detectAuth(auth?: GlobalAuthConfig): AuthFlags {
  if (!auth) return { jwt: false, apikey: false, oauth: false, any: false }
  const jwt = auth.jwt?.enabled === true || auth.strategy === 'jwt' || auth.strategy === 'bearer'
  const apikey = auth.apikey?.enabled === true || auth.strategy === 'apikey'
  const oauth = (auth.oauth?.providers?.length ?? 0) > 0
  return { jwt, apikey, oauth, any: jwt || apikey || oauth }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINTS: CrudAction[] = ['list', 'create', 'read', 'update', 'delete']
const RESERVED_FIELDS = new Set(['id', 'createdAt', 'updatedAt'])

function baseUrlValue(spec: ZeroAPISpec): string {
  return spec.baseUrl ?? 'http://localhost:3000'
}

function exampleValueFor(field: FieldDefinition, name: string): unknown {
  const t: FieldType = field.type
  if (field.values && field.values.length > 0) return field.values[0]
  if (field.default !== undefined && field.default !== null) return field.default
  switch (t) {
    case 'string':
    case 'text':
      return `exemple ${name}`
    case 'email':
      return 'user@example.com'
    case 'url':
      return 'https://example.com'
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000'
    case 'number':
    case 'decimal':
      return field.min ?? 0
    case 'integer':
      return field.min ?? 0
    case 'boolean':
      return true
    case 'date':
      return '2025-01-01'
    case 'datetime':
      return '2025-01-01T00:00:00Z'
    case 'json':
      return {}
    case 'enum':
      return field.values?.[0] ?? 'value'
    case 'file':
      return 'https://cdn.example.com/file.png'
    case 'file[]':
      return ['https://cdn.example.com/file.png']
  }
}

function buildSampleBody(resource: ResourceDefinition, mode: 'create' | 'update'): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const entries = Object.entries(resource.fields).filter(([name]) => !RESERVED_FIELDS.has(name))
  if (mode === 'create') {
    for (const [name, field] of entries) {
      if (field.required) body[name] = exampleValueFor(field, name)
    }
    if (Object.keys(body).length === 0) {
      for (const [name, field] of entries.slice(0, 1)) {
        body[name] = exampleValueFor(field, name)
      }
    }
  } else {
    for (const [name, field] of entries.slice(0, 1)) {
      body[name] = exampleValueFor(field, name)
    }
  }
  return body
}

function jsonBody(payload: unknown): PostmanRawBody {
  return {
    mode: 'raw',
    raw: JSON.stringify(payload, null, 2),
    options: { raw: { language: 'json' } },
  }
}

function urlFor(spec: ZeroAPISpec, segments: string[], query?: PostmanQueryParam[]): PostmanUrl {
  const pathVars = segments
    .filter((s) => s.startsWith(':'))
    .map((s) => ({ key: s.slice(1), value: '' }))
  const raw = `{{baseUrl}}/${segments.join('/')}`
  const url: PostmanUrl = {
    raw: query && query.length > 0 ? `${raw}?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : raw,
    host: ['{{baseUrl}}'],
    path: segments,
  }
  if (query && query.length > 0) url.query = query
  if (pathVars.length > 0) url.variable = pathVars
  return url
}

function jsonHeader(): PostmanHeader[] {
  return [{ key: 'Content-Type', value: 'application/json', type: 'text' }]
}

function tokenExtractionScript(): PostmanEvent {
  return {
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec: [
        'try {',
        '  var body = pm.response.json();',
        '  var token = (body && body.data && body.data.accessToken) || body.accessToken;',
        '  if (token) {',
        '    pm.collectionVariables.set("token", token);',
        '  }',
        '  var refresh = (body && body.data && body.data.refreshToken) || body.refreshToken;',
        '  if (refresh) {',
        '    pm.collectionVariables.set("refreshToken", refresh);',
        '  }',
        '} catch (e) {}',
      ],
    },
  }
}

// ── Auth folder ───────────────────────────────────────────────────────────────

function buildAuthFolder(spec: ZeroAPISpec): PostmanFolderItem {
  const noAuth: PostmanAuth = { type: 'noauth' }
  const items: PostmanRequestItem[] = []

  items.push({
    name: 'Register',
    request: {
      method: 'POST',
      header: jsonHeader(),
      url: urlFor(spec, ['auth', 'register']),
      body: jsonBody({ email: 'user@example.com', password: 'Sup3rSecret!' }),
      description: 'Crée un compte utilisateur et retourne un accessToken.',
      auth: noAuth,
    },
    event: [tokenExtractionScript()],
  })

  items.push({
    name: 'Login',
    request: {
      method: 'POST',
      header: jsonHeader(),
      url: urlFor(spec, ['auth', 'login']),
      body: jsonBody({ email: 'user@example.com', password: 'Sup3rSecret!' }),
      description: 'Authentifie un utilisateur et retourne accessToken + refreshToken. Le accessToken est automatiquement stocké dans la variable {{token}}.',
      auth: noAuth,
    },
    event: [tokenExtractionScript()],
  })

  items.push({
    name: 'Refresh',
    request: {
      method: 'POST',
      header: jsonHeader(),
      url: urlFor(spec, ['auth', 'refresh']),
      body: jsonBody({ refreshToken: '{{refreshToken}}' }),
      description: 'Échange un refreshToken contre un nouvel accessToken.',
      auth: noAuth,
    },
    event: [tokenExtractionScript()],
  })

  items.push({
    name: 'Logout',
    request: {
      method: 'POST',
      header: jsonHeader(),
      url: urlFor(spec, ['auth', 'logout']),
      body: jsonBody({ refreshToken: '{{refreshToken}}' }),
      description: 'Révoque le refreshToken courant.',
    },
  })

  items.push({
    name: 'Me',
    request: {
      method: 'GET',
      url: urlFor(spec, ['auth', 'me']),
      description: 'Retourne le profil de l\'utilisateur authentifié.',
    },
  })

  return {
    name: 'Auth',
    description: 'Endpoints d\'authentification (register, login, refresh, logout, me).',
    item: items,
  }
}

// ── OAuth folder (added when oauth providers are configured) ──────────────────

function buildOAuthFolder(spec: ZeroAPISpec): PostmanFolderItem | null {
  const providers = spec.auth?.oauth?.providers ?? []
  if (providers.length === 0) return null
  const items: PostmanRequestItem[] = []
  for (const p of providers) {
    items.push({
      name: `Start ${p.name}`,
      request: {
        method: 'GET',
        url: urlFor(spec, ['auth', 'oauth', p.name]),
        description: `Démarre le flux OAuth ${p.name} (redirige vers le provider).`,
        auth: { type: 'noauth' },
      },
    })
    items.push({
      name: `Callback ${p.name}`,
      request: {
        method: 'GET',
        url: urlFor(spec, ['auth', 'oauth', p.name, 'callback'], [
          { key: 'code', value: '<code-renvoyé-par-provider>' },
          { key: 'state', value: '<state>' },
        ]),
        description: `Callback OAuth ${p.name} — appelé par le provider après consentement.`,
        auth: { type: 'noauth' },
      },
      event: [tokenExtractionScript()],
    })
  }
  return {
    name: 'OAuth',
    description: 'Endpoints OAuth pour les providers configurés.',
    item: items,
  }
}

// ── Resource folder ───────────────────────────────────────────────────────────

function listQueryParams(resource: ResourceDefinition): PostmanQueryParam[] {
  const params: PostmanQueryParam[] = [
    { key: 'limit', value: '20', description: 'Nombre d\'éléments par page.' },
    { key: 'offset', value: '0', description: 'Index de départ (pagination).', disabled: true },
    { key: 'page', value: '1', description: 'Numéro de page (alternative à offset).', disabled: true },
    { key: 'sort', value: '-createdAt', description: 'Tri (préfixe `-` pour décroissant).', disabled: true },
  ]
  if ((resource.searchable?.length ?? 0) > 0) {
    params.push({ key: 'q', value: 'mot-clé', description: 'Recherche plein texte.', disabled: true })
  }
  const filterable = Object.entries(resource.fields).filter(([name]) => !RESERVED_FIELDS.has(name)).slice(0, 2)
  for (const [name, field] of filterable) {
    const sample = exampleValueFor(field, name)
    if (field.type === 'number' || field.type === 'integer' || field.type === 'decimal') {
      params.push({ key: `${name}[gte]`, value: String(sample ?? 0), description: `Filtre ${name} ≥`, disabled: true })
      params.push({ key: `${name}[lte]`, value: String(sample ?? 0), description: `Filtre ${name} ≤`, disabled: true })
    } else {
      params.push({ key: name, value: String(sample ?? ''), description: `Filtre exact sur ${name}.`, disabled: true })
    }
  }
  return params
}

function buildCustomEndpointRequest(
  spec: ZeroAPISpec,
  plural: string,
  ep: CustomEndpointDef,
): PostmanRequestItem {
  const cleanPath = ep.path.replace(/^\//, '')
  const segments = [plural, ...cleanPath.split('/').filter(Boolean)]
  const url = urlFor(spec, segments)
  const needsBody = ep.method === 'POST' || ep.method === 'PUT' || ep.method === 'PATCH'
  return {
    name: `${ep.method} ${ep.path}`,
    request: {
      method: ep.method,
      header: needsBody ? jsonHeader() : undefined,
      url,
      body: needsBody ? jsonBody({}) : undefined,
      description: `Endpoint personnalisé — handler \`${ep.handler}\`${ep.roles?.length ? ` (rôles : ${ep.roles.join(', ')})` : ''}.`,
    },
  }
}

function buildResourceFolder(
  spec: ZeroAPISpec,
  resource: ResourceDefinition,
): PostmanFolderItem {
  const plural = toPlural(resource.name)
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const items: PostmanRequestItem[] = []

  if (endpoints.includes('list')) {
    items.push({
      name: `List ${plural}`,
      request: {
        method: 'GET',
        url: urlFor(spec, [plural], listQueryParams(resource)),
        description: `Liste paginée des ${plural}.`,
      },
    })
  }

  if (endpoints.includes('create')) {
    items.push({
      name: `Create ${resource.name}`,
      request: {
        method: 'POST',
        header: jsonHeader(),
        url: urlFor(spec, [plural]),
        body: jsonBody(buildSampleBody(resource, 'create')),
        description: `Crée un(e) ${resource.name}.`,
      },
    })
  }

  if (endpoints.includes('read')) {
    items.push({
      name: `Get ${resource.name} by id`,
      request: {
        method: 'GET',
        url: urlFor(spec, [plural, ':id']),
        description: `Récupère un(e) ${resource.name} par son identifiant.`,
      },
    })
  }

  if (endpoints.includes('update')) {
    items.push({
      name: `Update ${resource.name}`,
      request: {
        method: 'PUT',
        header: jsonHeader(),
        url: urlFor(spec, [plural, ':id']),
        body: jsonBody(buildSampleBody(resource, 'update')),
        description: `Met à jour un(e) ${resource.name}.`,
      },
    })
  }

  if (endpoints.includes('delete')) {
    items.push({
      name: `Delete ${resource.name}`,
      request: {
        method: 'DELETE',
        url: urlFor(spec, [plural, ':id']),
        description: `Supprime un(e) ${resource.name}.`,
      },
    })
  }

  for (const ep of resource.customEndpoints ?? []) {
    items.push(buildCustomEndpointRequest(spec, plural, ep))
  }

  for (const rel of relationsFrom(spec, resource.name)) {
    const target = toPlural(rel.to)
    items.push({
      name: `List ${target} of ${resource.name}`,
      request: {
        method: 'GET',
        url: urlFor(spec, [plural, ':id', target]),
        description: `Relation ${rel.type} → ${rel.to}.`,
      },
    })
  }

  return {
    name: resource.name,
    description: resource.description ?? `Endpoints CRUD pour ${resource.name}.`,
    item: items,
  }
}

function relationsFrom(spec: ZeroAPISpec, from: string): SpecRelation[] {
  return (spec.relations ?? []).filter((r) => r.from === from)
}

// ── Upload folder ─────────────────────────────────────────────────────────────

function buildUploadFolder(spec: ZeroAPISpec): PostmanFolderItem | null {
  if (!spec.features?.fileUpload?.enabled) return null
  const fu = spec.features.fileUpload
  return {
    name: 'Upload',
    description: `Upload de fichiers (provider: ${fu.provider}, max ${fu.maxSizeMB} MB).`,
    item: [
      {
        name: 'Upload file',
        request: {
          method: 'POST',
          url: urlFor(spec, ['upload']),
          body: {
            mode: 'formdata',
            formdata: [
              {
                key: 'file',
                type: 'file',
                src: '',
                description: `Fichier à uploader${fu.allowedTypes.length > 0 ? ` (types autorisés : ${fu.allowedTypes.join(', ')})` : ''}.`,
              },
            ],
          },
          description: `Upload multipart/form-data du champ \`file\`.`,
        },
      },
    ],
  }
}

// ── Webhooks folder ───────────────────────────────────────────────────────────

function buildWebhooksFolder(spec: ZeroAPISpec): PostmanFolderItem | null {
  const wh = spec.features?.webhooks
  const outbound = wh?.outbound ?? []
  const inbound = wh?.inbound ?? []
  if (outbound.length === 0 && inbound.length === 0) return null

  const items: PostmanRequestItem[] = []

  if (outbound.length > 0) {
    items.push({
      name: 'Create webhook endpoint',
      request: {
        method: 'POST',
        header: jsonHeader(),
        url: urlFor(spec, ['admin', 'webhooks']),
        body: jsonBody({
          url: 'https://example.com/webhooks/receiver',
          events: outbound,
        }),
        description: 'Enregistre une URL qui recevra les événements sortants.',
      },
    })
    items.push({
      name: 'List webhook endpoints',
      request: {
        method: 'GET',
        url: urlFor(spec, ['admin', 'webhooks']),
        description: 'Liste les endpoints webhook enregistrés.',
      },
    })
    items.push({
      name: 'Delete webhook endpoint',
      request: {
        method: 'DELETE',
        url: urlFor(spec, ['admin', 'webhooks', ':id']),
        description: 'Supprime un endpoint webhook.',
      },
    })
    items.push({
      name: 'List deliveries',
      request: {
        method: 'GET',
        url: urlFor(spec, ['admin', 'webhooks', ':id', 'deliveries']),
        description: 'Historique des livraisons pour un endpoint.',
      },
    })
  }

  for (const src of inbound) {
    items.push({
      name: `Inbound ${src}`,
      request: {
        method: 'POST',
        header: jsonHeader(),
        url: urlFor(spec, ['webhooks', 'inbound', src]),
        body: jsonBody({}),
        description: `Webhook entrant pour la source ${src}.`,
        auth: { type: 'noauth' },
      },
    })
  }

  return {
    name: 'Webhooks',
    description: 'Gestion des endpoints webhook sortants et endpoints entrants.',
    item: items,
  }
}

// ── Collection-level auth ─────────────────────────────────────────────────────

function buildCollectionAuth(spec: ZeroAPISpec, flags: AuthFlags): PostmanAuth | undefined {
  if (flags.jwt) {
    return {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
    }
  }
  if (flags.apikey) {
    const header = spec.auth?.apikey?.header ?? spec.auth?.header ?? 'Authorization'
    return {
      type: 'apikey',
      apikey: [
        { key: 'key', value: header, type: 'string' },
        { key: 'value', value: '{{apiKey}}', type: 'string' },
        { key: 'in', value: 'header', type: 'string' },
      ],
    }
  }
  return undefined
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates a Postman Collection v2.1 object from a ZeroAPI spec.
 * The result is a plain JSON object that can be serialized and imported
 * directly into Postman, Insomnia or any compatible tool.
 *
 * Folders generated (adapt to the spec):
 *  - "Auth" — when JWT auth is enabled
 *  - "OAuth" — when at least one OAuth provider is configured
 *  - One folder per resource (CRUD + custom endpoints + nested relations)
 *  - "Upload" — when fileUpload feature is enabled
 *  - "Webhooks" — when outbound/inbound webhooks are declared
 *
 * Login/register/refresh requests embed a post-response script that
 * automatically extracts `accessToken` into the `{{token}}` collection
 * variable — so authenticated requests work right after login.
 */
export function generatePostmanCollection(spec: ZeroAPISpec): PostmanCollection {
  const flags = detectAuth(spec.auth)
  const auth = buildCollectionAuth(spec, flags)

  const variable: PostmanVariable[] = [
    { key: 'baseUrl', value: baseUrlValue(spec), type: 'string' },
    { key: 'token', value: '', type: 'string' },
    { key: 'refreshToken', value: '', type: 'string' },
    { key: 'apiKey', value: '', type: 'string' },
  ]

  const items: PostmanItem[] = []
  if (flags.jwt) items.push(buildAuthFolder(spec))
  const oauthFolder = buildOAuthFolder(spec)
  if (oauthFolder) items.push(oauthFolder)
  for (const resource of spec.resources) {
    items.push(buildResourceFolder(spec, resource))
  }
  const uploadFolder = buildUploadFolder(spec)
  if (uploadFolder) items.push(uploadFolder)
  const webhooksFolder = buildWebhooksFolder(spec)
  if (webhooksFolder) items.push(webhooksFolder)

  const collection: PostmanCollection = {
    info: {
      name: spec.name,
      description: spec.description ?? `Collection Postman générée par ZeroAPI pour ${spec.name}.`,
      schema: POSTMAN_SCHEMA_V2_1,
    },
    variable,
    item: items,
  }
  if (auth) collection.auth = auth
  return collection
}
