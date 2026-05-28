import { describe, it, expect } from 'vitest'
import { parseSpec, ParseError } from '../src/parser/index.js'

const baseResources = [
  { name: 'User', fields: { email: { type: 'email' as const, required: true } } },
  { name: 'Post', fields: { title: { type: 'string' as const, required: true } } },
]

describe('Phase 0 — Spec schema extensions', () => {
  describe('backwards compatibility', () => {
    it('accepts a minimal spec with only resources', () => {
      const spec = parseSpec({
        version: '1.0',
        name: 'minimal',
        resources: [{ name: 'Item', fields: { label: { type: 'string' } } }],
      })
      expect(spec.resources).toHaveLength(1)
      expect(spec.relations).toBeUndefined()
      expect(spec.env).toBeUndefined()
      expect(spec.permissions).toBeUndefined()
      expect(spec.features).toBeUndefined()
    })

    it('accepts the legacy auth shape ({ strategy, secret })', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        auth: { strategy: 'jwt', secret: 'super' },
        resources: baseResources,
      })
      expect(spec.auth?.strategy).toBe('jwt')
    })
  })

  describe('extended auth block', () => {
    it('accepts the modern auth shape with strategies + jwt + apikey + oauth', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        auth: {
          enabled: true,
          strategies: ['jwt', 'apikey', 'oauth'],
          jwt: {
            accessTokenTTL: '15m',
            refreshTokenTTL: '7d',
            secretEnv: 'JWT_SECRET',
          },
          apikey: { enabled: true, header: 'x-api-key', prefix: 'zak_live_' },
          oauth: {
            providers: [
              { name: 'google', clientIdEnv: 'GOOGLE_ID', clientSecretEnv: 'GOOGLE_SECRET', scopes: ['email'] },
              { name: 'github', clientIdEnv: 'GH_ID', clientSecretEnv: 'GH_SECRET' },
            ],
          },
          emailVerification: true,
          passwordReset: true,
        },
        resources: baseResources,
      })
      expect(spec.auth?.strategies).toEqual(['jwt', 'apikey', 'oauth'])
      expect(spec.auth?.oauth?.providers).toHaveLength(2)
    })

    it('rejects an unknown oauth provider', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          auth: {
            enabled: true,
            strategies: ['oauth'],
            oauth: { providers: [{ name: 'facebook', clientIdEnv: 'X', clientSecretEnv: 'Y' }] },
          },
          resources: baseResources,
        })
      ).toThrow(ParseError)
    })
  })

  describe('top-level relations', () => {
    it('accepts a valid top-level relation', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        resources: baseResources,
        relations: [
          { from: 'Post', to: 'User', type: 'many-to-one', field: 'authorId', onDelete: 'cascade' },
        ],
      })
      expect(spec.relations).toHaveLength(1)
      expect(spec.relations?.[0].type).toBe('many-to-one')
    })

    it('accepts a many-to-many relation with through table', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        resources: baseResources,
        relations: [
          { from: 'User', to: 'Post', type: 'many-to-many', field: 'posts', through: 'user_posts' },
        ],
      })
      expect(spec.relations?.[0].through).toBe('user_posts')
    })

    it('rejects relation with unknown "from" resource', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          resources: baseResources,
          relations: [{ from: 'Ghost', to: 'User', type: 'many-to-one', field: 'x' }],
        })
      ).toThrow(/unknown resource "Ghost"/)
    })

    it('rejects relation with unknown "to" resource', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          resources: baseResources,
          relations: [{ from: 'User', to: 'Phantom', type: 'one-to-many', field: 'posts' }],
        })
      ).toThrow(/unknown resource "Phantom"/)
    })

    it('rejects many-to-many without through', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          resources: baseResources,
          relations: [{ from: 'User', to: 'Post', type: 'many-to-many', field: 'posts' }],
        })
      ).toThrow(/requires a "through" field/)
    })

    it('rejects unknown relation type', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          resources: baseResources,
          relations: [{ from: 'User', to: 'Post', type: 'mystery', field: 'x' }],
        })
      ).toThrow(ParseError)
    })
  })

  describe('env block', () => {
    it('accepts env declarations', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        resources: baseResources,
        env: [
          { name: 'DATABASE_URL', required: true, description: 'Postgres URL' },
          { name: 'JWT_SECRET', required: true, generate: true },
          { name: 'STRIPE_KEY', required: false, managedByCloud: true, example: 'sk_test_...' },
        ],
      })
      expect(spec.env).toHaveLength(3)
      expect(spec.env?.[1].generate).toBe(true)
    })

    it('rejects env entry missing "required"', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          resources: baseResources,
          env: [{ name: 'DB' }],
        })
      ).toThrow(ParseError)
    })
  })

  describe('permissions block', () => {
    it('accepts valid permissions referencing existing resources', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        auth: { jwt: { enabled: true } },
        resources: [
          { name: 'Post', fields: { title: { type: 'string' as const, required: true } } },
        ],
        permissions: [
          {
            resource: 'Post',
            rules: [
              { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
              { role: 'user', actions: ['read', 'update'], ownOnly: true },
            ],
          },
        ],
      })
      expect(spec.permissions?.[0].rules).toHaveLength(2)
    })

    it('rejects permissions on unknown resource', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          resources: baseResources,
          permissions: [
            { resource: 'Comment', rules: [{ role: 'admin', actions: ['read'] }] },
          ],
        })
      ).toThrow(/unknown resource "Comment"/)
    })

    it('rejects empty action list', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          resources: baseResources,
          permissions: [{ resource: 'Post', rules: [{ role: 'admin', actions: [] }] }],
        })
      ).toThrow(ParseError)
    })
  })

  describe('features block', () => {
    it('accepts a full features config', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        resources: baseResources,
        features: {
          fileUpload: { enabled: true, provider: 's3', maxSizeMB: 10, allowedTypes: ['image/png', 'image/jpeg'] },
          webhooks: { outbound: ['order.created'], inbound: ['stripe.event'] },
          search: { enabled: true, fuzzy: true },
          rateLimit: { perKey: '100/min', public: '20/min' },
          pagination: { defaultLimit: 25, maxLimit: 200 },
        },
      })
      expect(spec.features?.fileUpload?.provider).toBe('s3')
      expect(spec.features?.pagination?.maxLimit).toBe(200)
    })

    it('accepts partial features (all sub-blocks optional)', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        resources: baseResources,
        features: { search: { enabled: false } },
      })
      expect(spec.features?.search?.enabled).toBe(false)
    })

    it('rejects unknown upload provider', () => {
      expect(() =>
        parseSpec({
          version: '1.0', name: 'api',
          resources: baseResources,
          features: { fileUpload: { enabled: true, provider: 'azure', maxSizeMB: 1, allowedTypes: [] } },
        })
      ).toThrow(ParseError)
    })
  })

  describe('extended resource fields', () => {
    it('accepts new field flags (index, unique, default)', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        resources: [
          {
            name: 'Account',
            fields: {
              slug: { type: 'string', unique: true, index: true },
              status: { type: 'enum', values: ['active', 'pending'], default: 'pending' },
              balance: { type: 'decimal', default: 0 },
              metadata: { type: 'json', default: { foo: 'bar' } },
              avatars: { type: 'file[]' },
            },
          },
        ],
      })
      expect(spec.resources[0].fields.slug.index).toBe(true)
      expect(spec.resources[0].fields.metadata.default).toEqual({ foo: 'bar' })
    })

    it('accepts resource-level options (softDelete, timestamps, searchable)', () => {
      const spec = parseSpec({
        version: '1.0', name: 'api',
        resources: [
          {
            name: 'Article',
            fields: { title: { type: 'string' }, body: { type: 'text' } },
            softDelete: true,
            timestamps: true,
            searchable: ['title', 'body'],
          },
        ],
      })
      expect(spec.resources[0].softDelete).toBe(true)
      expect(spec.resources[0].searchable).toEqual(['title', 'body'])
    })
  })

  describe('full Phase 0 spec', () => {
    it('parses a spec that uses every new block at once', () => {
      const spec = parseSpec({
        version: '0.2.0',
        name: 'kitchen-sink',
        auth: {
          enabled: true,
          strategies: ['jwt', 'apikey'],
          jwt: { accessTokenTTL: '15m', refreshTokenTTL: '7d', secretEnv: 'JWT_SECRET' },
          apikey: { enabled: true, header: 'x-api-key', prefix: 'zak_live_' },
          emailVerification: true,
          passwordReset: true,
        },
        resources: [
          {
            name: 'User',
            fields: {
              email: { type: 'email', required: true, unique: true, index: true },
              role: { type: 'enum', values: ['admin', 'user'], default: 'user' },
            },
            softDelete: true,
            searchable: ['email'],
          },
          {
            name: 'Post',
            fields: {
              title: { type: 'string', required: true },
              body: { type: 'text' },
              attachments: { type: 'file[]' },
            },
            timestamps: true,
            searchable: ['title', 'body'],
          },
        ],
        relations: [
          { from: 'Post', to: 'User', type: 'many-to-one', field: 'authorId', onDelete: 'cascade' },
        ],
        env: [
          { name: 'DATABASE_URL', required: true },
          { name: 'JWT_SECRET', required: true, generate: true },
        ],
        permissions: [
          {
            resource: 'Post',
            rules: [
              { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
              { role: 'user', actions: ['read', 'update'] },
            ],
          },
        ],
        features: {
          fileUpload: { enabled: true, provider: 'r2', maxSizeMB: 25, allowedTypes: ['image/*'] },
          search: { enabled: true, fuzzy: true },
          pagination: { defaultLimit: 20, maxLimit: 100 },
        },
      })

      expect(spec.relations).toHaveLength(1)
      expect(spec.env).toHaveLength(2)
      expect(spec.permissions).toHaveLength(1)
      expect(spec.features?.fileUpload?.provider).toBe('r2')
    })
  })
})
