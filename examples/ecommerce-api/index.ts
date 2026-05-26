/**
 * E-commerce API example — full feature set (v0.1.0 final):
 *   JWT auth, RBAC, relations, transactions, file upload, filtering, docs,
 *   lifecycle hooks (Chantier 1), observability (Chantier 2),
 *   distributed rate limiting (Chantier 3), env validation (Chantier 4),
 *   and auth flows (Chantier 5).
 *
 * Roles:
 *   admin     → full access (inherits manager)
 *   manager   → read/write products + orders, delete own content (inherits staff)
 *   staff     → read products + orders, create orders (inherits customer)
 *   customer  → read products, create/read own orders
 *
 * Custom business logic:
 *   - Purchase beforeCreate hook: rejects purchase if quantity is 0
 *   - Product POST /products/bestsellers: custom endpoint returning top products
 *
 * Run with: npx tsx examples/ecommerce-api/index.ts
 */
import { parseSpec, createRuntime } from '../../src/index.js'
import type { HandlerFn } from '../../src/index.js'

const spec = parseSpec({
  version: '1.0.0',
  name: 'ecommerce-api',
  description: 'Full-featured e-commerce API with relations, transactions, hooks, and auth flows',
  auth: {
    strategy: 'jwt',
    secret: process.env['JWT_SECRET'] ?? 'ecommerce-dev-secret',
  },
  roles: [
    { name: 'admin',    description: 'Full access', inherits: ['manager'] },
    { name: 'manager',  description: 'Product and order management', inherits: ['staff'] },
    { name: 'staff',    description: 'Operational access', inherits: ['customer'] },
    { name: 'customer', description: 'Shopping access' },
  ],
  rateLimit: {
    windowMs: 60_000,
    max: 60,
    byUser: true,
  },
  cors: {
    origins: [
      'https://shop.example.com',
      'https://admin.example.com',
      'http://localhost:3000',
    ],
    credentials: true,
  },
  // Chantier 4: validate required env vars at startup
  requiredEnv: [],

  // Chantier 5: auth flows (register/login/verify/reset/refresh/logout)
  authFlows: {
    emailVerification: false,  // set to true in production
    passwordReset: true,
    refreshTokens: true,
    revocation: true,
    lockout: { maxAttempts: 5, windowMs: 15 * 60 * 1000 },
  },

  resources: [
    // ── Category ─────────────────────────────────────────────────────────────
    {
      name: 'Category',
      description: 'Product categories',
      fields: {
        name:        { type: 'string', required: true, unique: true },
        slug:        { type: 'string', required: true, unique: true },
        description: { type: 'text',   required: false },
      },
      endpoints: ['list', 'read', 'create', 'update', 'delete'],
      rbac: {
        write:  ['manager'],
        delete: ['admin'],
      },
    },

    // ── Tag ───────────────────────────────────────────────────────────────────
    {
      name: 'Tag',
      description: 'Product tags for manyToMany demo',
      fields: {
        label: { type: 'string', required: true, unique: true },
      },
      rbac: { write: ['manager'], delete: ['admin'] },
    },

    // ── Product ───────────────────────────────────────────────────────────────
    {
      name: 'Product',
      description: 'Catalogue items with category relation, tag many-to-many, and image upload',
      fields: {
        name:        { type: 'string',  required: true,  maxLength: 200 },
        description: { type: 'text',    required: false, maxLength: 2000 },
        price:       { type: 'number',  required: true,  min: 0 },
        stock:       { type: 'integer', required: true,  min: 0 },
        sku:         { type: 'string',  required: true },
        active:      { type: 'boolean', required: false, default: true },
        // File upload: POST multipart/form-data with image field
        image:       { type: 'file',    required: false, accept: ['image/jpeg', 'image/png', 'image/webp'], maxSize: '5MB', storage: 'local' },
      },
      relations: [
        { type: 'manyToOne', resource: 'Category', field: 'categoryId', required: false, onDelete: 'SetNull' },
        { type: 'manyToMany', resource: 'Tag', through: 'product_tags', fields: { position: { type: 'integer' } } },
      ],
      rbac: {
        read:   ['customer'],
        write:  ['manager'],
        delete: ['admin'],
      },
      // Chantier 1: custom endpoint
      customEndpoints: [
        {
          method: 'GET',
          path: '/bestsellers',
          handler: 'productBestsellers',
        },
      ],
    },

    // ── Purchase ──────────────────────────────────────────────────────────────
    {
      name: 'Purchase',
      description: 'Order line items — creating a purchase atomically decrements product stock',
      fields: {
        productId: { type: 'uuid',    required: true },
        quantity:  { type: 'integer', required: true, min: 1 },
        unitPrice: { type: 'number',  required: true, min: 0 },
      },
      relations: [
        { type: 'manyToOne', resource: 'Product', field: 'productId', required: true },
      ],
      // Chantier 1: lifecycle hooks
      hooks: {
        beforeCreate: 'purchaseBeforeCreate',
        afterCreate:  'purchaseAfterCreate',
      },
      // Transaction: on POST, atomically decrement product.stock by purchase.quantity
      transactions: [
        {
          trigger: 'POST',
          operations: [
            {
              action: 'decrement',
              resource: 'product',
              idFrom: 'productId',
              field: 'stock',
              amountFrom: 'quantity',
            },
          ],
        },
      ],
      rbac: {
        read:   ['staff'],
        write:  ['customer'],
        delete: ['manager'],
      },
    },

    // ── Order ─────────────────────────────────────────────────────────────────
    {
      name: 'Order',
      description: 'Customer orders with purchases relation',
      fields: {
        status:     { type: 'string',  required: true,  default: 'pending' },
        totalCents: { type: 'integer', required: true,  min: 0 },
        notes:      { type: 'text',    required: false },
      },
      rbac: {
        read:   ['staff'],
        write:  ['customer'],
        delete: ['manager'],
      },
    },
  ],
})

// Chantier 1: handler implementations
const handlers: Record<string, HandlerFn> = {
  // beforeCreate hook: validates business rules before persisting
  purchaseBeforeCreate: ({ input }) => {
    const quantity = input['quantity']
    if (typeof quantity === 'number' && quantity <= 0) {
      throw new Error('Purchase quantity must be greater than zero')
    }
    // You can also mutate input here, e.g.:
    // input['processedAt'] = new Date().toISOString()
  },

  // afterCreate hook: fire-and-forget side effect (e.g. analytics, audit log)
  purchaseAfterCreate: ({ input }) => {
    const productId = input['productId']
    const quantity = input['quantity']
    console.log(`[AUDIT] New purchase: productId=${String(productId)} qty=${String(quantity)}`)
  },

  // Custom endpoint: returns top 3 products by price (demo)
  productBestsellers: ({ store, ctx }) => {
    const productStore = store.get('product')
    const products = Array.from(productStore?.values() ?? [])
      .sort((a, b) => (b['price'] as number) - (a['price'] as number))
      .slice(0, 3)
    return ctx.json({ data: products, count: products.length })
  },
}

const { app, prismaSchema, openApiSpec, zodSchemas } = createRuntime(spec, {
  enableDocs: true,
  uploadDir: '/tmp/ecommerce-uploads',
  handlers,
  logLevel: 'info',
  validateEnv: false,  // set true in production
})

console.log('=== E-Commerce API v0.1.0 — Sprint Final ===')
console.log('Chantier 1: Hooks + custom endpoints')
console.log('Chantier 2: /health (uptime) · /ready · request-id header')
console.log('Chantier 3: Distributed rate limiter (MemoryStore by default)')
console.log('Chantier 4: Env var validation at boot')
console.log('Chantier 5: Auth flows (register/login/reset/refresh/logout)')
console.log()
console.log('Auth endpoints:')
console.log('  POST /auth/register  { email, password }')
console.log('  POST /auth/login     { email, password }')
console.log('  POST /auth/forgot-password { email }')
console.log('  POST /auth/reset-password  { token, newPassword }')
console.log('  POST /auth/refresh   { refreshToken }')
console.log('  POST /auth/logout    { refreshToken }')
console.log()
console.log('Custom endpoints:')
console.log('  GET /products/bestsellers — top 3 products by price')
console.log()
console.log('Hooks:')
console.log('  Purchase.beforeCreate — validates quantity > 0')
console.log('  Purchase.afterCreate  — logs audit trail')
console.log()
console.log('Resources:')
for (const resource of spec.resources) {
  const schemaKeys = Object.keys(zodSchemas[resource.name] ?? {})
  const rels = resource.relations?.map((r) => `${r.type}→${r.resource}`).join(', ') ?? 'none'
  const txs  = resource.transactions?.map((t) => `${t.trigger}:tx`).join(', ') ?? 'none'
  const hks  = resource.hooks ? Object.entries(resource.hooks).filter(([, v]) => v).map(([k]) => k).join(', ') : 'none'
  console.log(`  /${resource.name.toLowerCase()}s`)
  console.log(`    schemas: [${schemaKeys.join(', ')}]`)
  console.log(`    relations: ${rels}`)
  console.log(`    transactions: ${txs}`)
  console.log(`    hooks: ${hks}`)
}
console.log()
console.log('OpenAPI paths:', Object.keys(openApiSpec.paths).join(', '))
console.log()
console.log('--- Prisma Schema (first 25 lines) ---')
console.log(prismaSchema.split('\n').slice(0, 25).join('\n'))
console.log('...')

export { app }
