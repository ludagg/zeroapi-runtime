/**
 * E-commerce API example — full feature set:
 *   JWT auth, RBAC, relations, transactions, file upload, filtering, docs.
 *
 * Roles:
 *   admin     → full access (inherits manager)
 *   manager   → read/write products + orders, delete own content (inherits staff)
 *   staff     → read products + orders, create orders (inherits customer)
 *   customer  → read products, create/read own orders
 *
 * New in v0.1.0:
 *   - Product ←manyToOne→ Category (category relation)
 *   - Product ←manyToMany→ Tag (via product_tags join table)
 *   - Order ←manyToOne→ Product (with stock decrement transaction on purchase)
 *   - Product.image file field (local storage)
 *   - GET /products?include=Category&price[lte]=100&sort=name:asc
 *
 * Run with: npx tsx examples/ecommerce-api/index.ts
 */
import { parseSpec, createRuntime } from '../../src/index.js'

const spec = parseSpec({
  version: '1.0.0',
  name: 'ecommerce-api',
  description: 'Full-featured e-commerce API with relations, transactions, and file upload',
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
        // Many products belong to one category
        { type: 'manyToOne', resource: 'Category', field: 'categoryId', required: false, onDelete: 'SetNull' },
        // Products have many tags (via join table)
        { type: 'manyToMany', resource: 'Tag', through: 'product_tags', fields: { position: { type: 'integer' } } },
      ],
      rbac: {
        read:   ['customer'],
        write:  ['manager'],
        delete: ['admin'],
      },
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

const { app, prismaSchema, openApiSpec, zodSchemas } = createRuntime(spec, {
  enableDocs: true,
  uploadDir: '/tmp/ecommerce-uploads',
})

console.log('=== E-Commerce API v0.1.0 ===')
console.log('Features: JWT auth · RBAC · relations · transactions · file upload · cursor pagination')
console.log()
console.log('Roles: admin > manager > staff > customer')
console.log()
console.log('Resources:')
for (const resource of spec.resources) {
  const schemaKeys = Object.keys(zodSchemas[resource.name] ?? {})
  const rels = resource.relations?.map((r) => `${r.type}→${r.resource}`).join(', ') ?? 'none'
  const txs  = resource.transactions?.map((t) => `${t.trigger}:tx`).join(', ') ?? 'none'
  console.log(`  /${resource.name.toLowerCase()}s`)
  console.log(`    schemas: [${schemaKeys.join(', ')}]`)
  console.log(`    relations: ${rels}`)
  console.log(`    transactions: ${txs}`)
}
console.log()
console.log('Query examples:')
console.log('  GET /products?include=Category&price[lte]=100&sort=name:asc&limit=10')
console.log('  GET /products?include=Tag&sku[startsWith]=ELEC')
console.log('  GET /purchases?include=Product&limit=5&cursor=<id>')
console.log()
console.log('Upload example:')
console.log('  POST /products  (multipart/form-data with image field)')
console.log()
console.log('Transaction example:')
console.log('  POST /purchases { productId, quantity }  → decrements product.stock atomically')
console.log('  → returns 409 if stock would go negative')
console.log()
console.log('OpenAPI paths:', Object.keys(openApiSpec.paths).join(', '))
console.log()
console.log('--- Prisma Schema (first 25 lines) ---')
console.log(prismaSchema.split('\n').slice(0, 25).join('\n'))
console.log('...')

export { app }
