import { describe, it, expect } from 'vitest'
import {
  generatePostmanCollection,
  POSTMAN_SCHEMA_V2_1,
  type PostmanCollection,
  type PostmanFolderItem,
  type PostmanRequestItem,
  type PostmanItem,
  type PostmanRawBody,
} from '../../src/docs/postman.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

// ── Test fixtures ─────────────────────────────────────────────────────────────

const minimalSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'minimal-api',
  resources: [
    {
      name: 'Item',
      fields: {
        label: { type: 'string', required: true },
      },
    },
  ],
}

const fullSpec: ZeroAPISpec = {
  version: '2.0.0',
  name: 'shop-api',
  description: 'API e-commerce générée par ZeroAPI.',
  baseUrl: 'https://api.shop.example',
  auth: {
    jwt: { enabled: true },
    oauth: {
      providers: [
        { name: 'google', clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' },
      ],
    },
  },
  features: {
    fileUpload: {
      enabled: true,
      provider: 's3',
      maxSizeMB: 10,
      allowedTypes: ['image/png', 'image/jpeg'],
    },
    webhooks: {
      outbound: ['order.created', 'order.paid'],
      inbound: ['stripe'],
    },
    search: { enabled: true },
    pagination: { defaultLimit: 25, maxLimit: 200 },
  },
  relations: [
    { from: 'Order', to: 'Product', type: 'many-to-one', field: 'productId' },
  ],
  resources: [
    {
      name: 'Product',
      description: 'Articles vendus dans la boutique.',
      fields: {
        title: { type: 'string', required: true },
        price: { type: 'decimal', required: true },
        description: { type: 'text', required: false },
      },
      searchable: ['title'],
    },
    {
      name: 'Order',
      fields: {
        productId: { type: 'uuid', required: true },
        quantity: { type: 'integer', required: true, min: 1 },
      },
      customEndpoints: [
        { method: 'POST', path: '/:id/refund', handler: 'refundOrder', auth: true, roles: ['admin'] },
      ],
    },
  ],
}

const apiKeySpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'apikey-api',
  auth: {
    apikey: { enabled: true, header: 'X-API-Key', prefix: 'svc_' },
  },
  resources: [
    {
      name: 'Widget',
      fields: { name: { type: 'string', required: true } },
    },
  ],
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findFolder(coll: PostmanCollection, name: string): PostmanFolderItem | undefined {
  return coll.item.find((it): it is PostmanFolderItem => 'item' in it && it.name === name)
}

function findRequest(folder: PostmanFolderItem, name: string): PostmanRequestItem | undefined {
  return folder.item.find((it): it is PostmanRequestItem => 'request' in it && it.name === name)
}

function findRequestStartsWith(folder: PostmanFolderItem, prefix: string): PostmanRequestItem | undefined {
  return folder.item.find((it): it is PostmanRequestItem => 'request' in it && it.name.startsWith(prefix))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generatePostmanCollection — collection structure (v2.1)', () => {
  it('returns the v2.1 schema URL on info', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(coll.info.schema).toBe(POSTMAN_SCHEMA_V2_1)
  })

  it('uses the spec name on info.name', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(coll.info.name).toBe('minimal-api')
  })

  it('includes a description on info', () => {
    const coll = generatePostmanCollection(fullSpec)
    expect(coll.info.description).toBe('API e-commerce générée par ZeroAPI.')
  })

  it('serializes to valid JSON', () => {
    const coll = generatePostmanCollection(fullSpec)
    const json = JSON.stringify(coll)
    expect(() => JSON.parse(json)).not.toThrow()
    const reparsed = JSON.parse(json) as PostmanCollection
    expect(reparsed.info.schema).toBe(POSTMAN_SCHEMA_V2_1)
  })

  it('has an item array at the top level', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(Array.isArray(coll.item)).toBe(true)
    expect(coll.item.length).toBeGreaterThan(0)
  })
})

describe('generatePostmanCollection — collection variables', () => {
  it('defines baseUrl, token and apiKey variables', () => {
    const coll = generatePostmanCollection(minimalSpec)
    const keys = coll.variable.map((v) => v.key)
    expect(keys).toContain('baseUrl')
    expect(keys).toContain('token')
    expect(keys).toContain('apiKey')
  })

  it('uses spec.baseUrl as the default baseUrl value', () => {
    const coll = generatePostmanCollection(fullSpec)
    const baseUrl = coll.variable.find((v) => v.key === 'baseUrl')
    expect(baseUrl?.value).toBe('https://api.shop.example')
  })

  it('falls back to localhost when baseUrl is not provided', () => {
    const coll = generatePostmanCollection(minimalSpec)
    const baseUrl = coll.variable.find((v) => v.key === 'baseUrl')
    expect(baseUrl?.value).toBe('http://localhost:3000')
  })

  it('starts token and apiKey as empty strings', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(coll.variable.find((v) => v.key === 'token')?.value).toBe('')
    expect(coll.variable.find((v) => v.key === 'apiKey')?.value).toBe('')
  })
})

describe('generatePostmanCollection — auth strategy', () => {
  it('configures bearer auth on the collection when JWT is enabled', () => {
    const coll = generatePostmanCollection(fullSpec)
    expect(coll.auth?.type).toBe('bearer')
    expect(coll.auth?.bearer?.[0]?.value).toBe('{{token}}')
  })

  it('configures apikey auth on the collection when API keys are enabled', () => {
    const coll = generatePostmanCollection(apiKeySpec)
    expect(coll.auth?.type).toBe('apikey')
    const entries = coll.auth?.apikey ?? []
    expect(entries.find((e) => e.key === 'value')?.value).toBe('{{apiKey}}')
    expect(entries.find((e) => e.key === 'key')?.value).toBe('X-API-Key')
    expect(entries.find((e) => e.key === 'in')?.value).toBe('header')
  })

  it('omits collection-level auth when the spec has no auth', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(coll.auth).toBeUndefined()
  })
})

describe('generatePostmanCollection — Auth folder', () => {
  it('is present when JWT auth is enabled', () => {
    const coll = generatePostmanCollection(fullSpec)
    expect(findFolder(coll, 'Auth')).toBeDefined()
  })

  it('is absent when JWT auth is not enabled', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(findFolder(coll, 'Auth')).toBeUndefined()
  })

  it('contains register, login, refresh, logout and me requests', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Auth')!
    expect(findRequest(folder, 'Register')).toBeDefined()
    expect(findRequest(folder, 'Login')).toBeDefined()
    expect(findRequest(folder, 'Refresh')).toBeDefined()
    expect(findRequest(folder, 'Logout')).toBeDefined()
    expect(findRequest(folder, 'Me')).toBeDefined()
  })

  it('uses the configured baseUrl variable on URLs', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Auth')!
    const login = findRequest(folder, 'Login')!
    expect(login.request.url.host).toEqual(['{{baseUrl}}'])
    expect(login.request.url.path).toEqual(['auth', 'login'])
    expect(login.request.url.raw.startsWith('{{baseUrl}}/auth/login')).toBe(true)
  })

  it('overrides login/register/refresh with noauth (so they do not require a token)', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Auth')!
    expect(findRequest(folder, 'Login')!.request.auth?.type).toBe('noauth')
    expect(findRequest(folder, 'Register')!.request.auth?.type).toBe('noauth')
    expect(findRequest(folder, 'Refresh')!.request.auth?.type).toBe('noauth')
  })
})

describe('generatePostmanCollection — token extraction script', () => {
  it('attaches a test script on the Login request', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Auth')!
    const login = findRequest(folder, 'Login')!
    const scripts = login.event ?? []
    expect(scripts.length).toBeGreaterThan(0)
    const testScript = scripts.find((e) => e.listen === 'test')
    expect(testScript).toBeDefined()
    const code = testScript!.script.exec.join('\n')
    expect(code).toContain('pm.collectionVariables.set("token"')
    expect(code).toContain('accessToken')
  })

  it('attaches the same extraction script on Register', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Auth')!
    const register = findRequest(folder, 'Register')!
    const code = register.event?.[0]?.script.exec.join('\n') ?? ''
    expect(code).toContain('pm.collectionVariables.set("token"')
  })

  it('reads accessToken from both body.accessToken and body.data.accessToken', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Auth')!
    const code = findRequest(folder, 'Login')!.event![0]!.script.exec.join('\n')
    expect(code).toContain('body.data.accessToken')
    expect(code).toContain('body.accessToken')
  })
})

describe('generatePostmanCollection — resource folders (CRUD)', () => {
  it('creates one folder per resource', () => {
    const coll = generatePostmanCollection(fullSpec)
    expect(findFolder(coll, 'Product')).toBeDefined()
    expect(findFolder(coll, 'Order')).toBeDefined()
  })

  it('uses the resource description on the folder', () => {
    const coll = generatePostmanCollection(fullSpec)
    expect(findFolder(coll, 'Product')!.description).toContain('Articles')
  })

  it('contains list/get/create/update/delete requests for default endpoints', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Product')!
    expect(findRequestStartsWith(folder, 'List ')).toBeDefined()
    expect(findRequest(folder, 'Create Product')).toBeDefined()
    expect(findRequest(folder, 'Get Product by id')).toBeDefined()
    expect(findRequest(folder, 'Update Product')).toBeDefined()
    expect(findRequest(folder, 'Delete Product')).toBeDefined()
  })

  it('uses the plural resource name in URL paths', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Product')!
    const list = findRequestStartsWith(folder, 'List ')!
    expect(list.request.url.path).toEqual(['products'])
  })

  it('declares :id as a path variable on item-scoped endpoints', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Product')!
    const get = findRequest(folder, 'Get Product by id')!
    expect(get.request.url.path).toEqual(['products', ':id'])
    expect(get.request.url.variable?.[0]?.key).toBe('id')
  })

  it('respects endpoints restriction on a resource', () => {
    const restrictedSpec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'restricted',
      resources: [
        {
          name: 'News',
          fields: { headline: { type: 'string', required: true } },
          endpoints: ['list', 'read'],
        },
      ],
    }
    const coll = generatePostmanCollection(restrictedSpec)
    const folder = findFolder(coll, 'News')!
    expect(findRequest(folder, 'Create News')).toBeUndefined()
    expect(findRequest(folder, 'Delete News')).toBeUndefined()
    expect(findRequest(folder, 'Get News by id')).toBeDefined()
  })
})

describe('generatePostmanCollection — request bodies (real fields)', () => {
  it('includes the real required fields in the create body', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Product')!
    const create = findRequest(folder, 'Create Product')!
    const body = create.request.body as PostmanRawBody
    expect(body.mode).toBe('raw')
    expect(body.options?.raw.language).toBe('json')
    const parsed = JSON.parse(body.raw) as Record<string, unknown>
    expect(parsed).toHaveProperty('title')
    expect(parsed).toHaveProperty('price')
    // optional field excluded from create body when there are required ones
    expect(parsed).not.toHaveProperty('description')
  })

  it('declares Content-Type: application/json on requests with a JSON body', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Product')!
    const create = findRequest(folder, 'Create Product')!
    const headers = create.request.header ?? []
    expect(headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json')).toBe(true)
  })

  it('uses field types to generate example values', () => {
    const typedSpec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'typed',
      resources: [
        {
          name: 'Event',
          fields: {
            title: { type: 'string', required: true },
            attendees: { type: 'integer', required: true, min: 1 },
            active: { type: 'boolean', required: true },
            startsAt: { type: 'datetime', required: true },
          },
        },
      ],
    }
    const coll = generatePostmanCollection(typedSpec)
    const folder = findFolder(coll, 'Event')!
    const create = findRequest(folder, 'Create Event')!
    const body = JSON.parse((create.request.body as PostmanRawBody).raw) as Record<string, unknown>
    expect(typeof body.title).toBe('string')
    expect(typeof body.attendees).toBe('number')
    expect(typeof body.active).toBe('boolean')
    expect(body.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('generatePostmanCollection — list query params', () => {
  it('documents limit, sort, page query params on list requests', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Product')!
    const list = findRequestStartsWith(folder, 'List ')!
    const keys = (list.request.url.query ?? []).map((q) => q.key)
    expect(keys).toContain('limit')
    expect(keys).toContain('sort')
    expect(keys).toContain('page')
  })

  it('disables advanced query params by default', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Product')!
    const list = findRequestStartsWith(folder, 'List ')!
    const params = list.request.url.query ?? []
    const sort = params.find((q) => q.key === 'sort')
    expect(sort?.disabled).toBe(true)
  })

  it('adds a `q` search param when the resource is searchable', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Product')!
    const list = findRequestStartsWith(folder, 'List ')!
    const params = list.request.url.query ?? []
    expect(params.some((q) => q.key === 'q')).toBe(true)
  })
})

describe('generatePostmanCollection — relations (nested requests)', () => {
  it('adds a nested request when a resource has an outgoing relation', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Order')!
    const nested = folder.item.find((it): it is PostmanRequestItem =>
      'request' in it && it.request.url.path.join('/') === 'orders/:id/products'
    )
    expect(nested).toBeDefined()
  })
})

describe('generatePostmanCollection — custom endpoints', () => {
  it('adds custom endpoints to the resource folder', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Order')!
    const custom = folder.item.find((it): it is PostmanRequestItem =>
      'request' in it && it.request.url.path.join('/') === 'orders/:id/refund'
    )
    expect(custom).toBeDefined()
    expect(custom!.request.method).toBe('POST')
  })
})

describe('generatePostmanCollection — Upload folder', () => {
  it('is present when fileUpload is enabled', () => {
    const coll = generatePostmanCollection(fullSpec)
    expect(findFolder(coll, 'Upload')).toBeDefined()
  })

  it('uses formdata mode with a file field', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Upload')!
    const req = findRequest(folder, 'Upload file')!
    const body = req.request.body
    expect(body?.mode).toBe('formdata')
    if (body?.mode === 'formdata') {
      expect(body.formdata[0]?.key).toBe('file')
      expect(body.formdata[0]?.type).toBe('file')
    }
  })

  it('is absent when fileUpload is disabled', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(findFolder(coll, 'Upload')).toBeUndefined()
  })
})

describe('generatePostmanCollection — Webhooks folder', () => {
  it('is present when webhooks (outbound or inbound) are declared', () => {
    const coll = generatePostmanCollection(fullSpec)
    expect(findFolder(coll, 'Webhooks')).toBeDefined()
  })

  it('lists CRUD requests for webhook endpoints when outbound events exist', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Webhooks')!
    expect(findRequest(folder, 'Create webhook endpoint')).toBeDefined()
    expect(findRequest(folder, 'List webhook endpoints')).toBeDefined()
    expect(findRequest(folder, 'Delete webhook endpoint')).toBeDefined()
  })

  it('embeds the declared outbound events in the create-endpoint body', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Webhooks')!
    const create = findRequest(folder, 'Create webhook endpoint')!
    const body = JSON.parse((create.request.body as PostmanRawBody).raw) as { events: string[] }
    expect(body.events).toContain('order.created')
    expect(body.events).toContain('order.paid')
  })

  it('lists one inbound request per declared inbound source', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'Webhooks')!
    expect(findRequest(folder, 'Inbound stripe')).toBeDefined()
  })

  it('is absent when no webhook events are declared', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(findFolder(coll, 'Webhooks')).toBeUndefined()
  })
})

describe('generatePostmanCollection — OAuth folder', () => {
  it('is present when OAuth providers are configured', () => {
    const coll = generatePostmanCollection(fullSpec)
    expect(findFolder(coll, 'OAuth')).toBeDefined()
  })

  it('contains a Start request per configured provider', () => {
    const coll = generatePostmanCollection(fullSpec)
    const folder = findFolder(coll, 'OAuth')!
    expect(findRequest(folder, 'Start google')).toBeDefined()
  })

  it('is absent when no provider is configured', () => {
    const coll = generatePostmanCollection(minimalSpec)
    expect(findFolder(coll, 'OAuth')).toBeUndefined()
  })
})

describe('generatePostmanCollection — minimal spec → minimal valid collection', () => {
  it('produces a collection with exactly one resource folder and no auth section', () => {
    const coll = generatePostmanCollection(minimalSpec)
    const folders = coll.item.filter((it): it is PostmanFolderItem => 'item' in it)
    expect(folders).toHaveLength(1)
    expect(folders[0]!.name).toBe('Item')
    expect(coll.auth).toBeUndefined()
  })

  it('still has all three variables (baseUrl/token/apiKey) for forwards-compat', () => {
    const coll = generatePostmanCollection(minimalSpec)
    const keys = coll.variable.map((v) => v.key)
    expect(keys).toContain('baseUrl')
    expect(keys).toContain('token')
    expect(keys).toContain('apiKey')
  })

  it('every request URL uses {{baseUrl}}', () => {
    const coll = generatePostmanCollection(minimalSpec)
    const collect = (item: PostmanItem): PostmanRequestItem[] => {
      if ('request' in item) return [item]
      return item.item.flatMap(collect)
    }
    const reqs = coll.item.flatMap(collect)
    for (const r of reqs) {
      expect(r.request.url.host).toEqual(['{{baseUrl}}'])
    }
  })
})
