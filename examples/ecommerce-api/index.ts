/**
 * E-commerce API example — full feature set: JWT auth, RBAC, rate limiting, CORS, docs.
 *
 * Roles:
 *   admin     → full access (inherits manager)
 *   manager   → read/write products + orders, delete own content (inherits staff)
 *   staff     → read products + orders, create orders (inherits customer)
 *   customer  → read products, create/read own orders
 *
 * Run with: npx tsx examples/ecommerce-api/index.ts
 */
import { parseSpec, createRuntime } from '../../src/index.js'

const spec = parseSpec({
  version: '1.0.0',
  name: 'ecommerce-api',
  description: 'Full-featured e-commerce API with RBAC',
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
    windowMs: 60_000,  // 1 minute
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
    {
      name: 'Product',
      description: 'Catalogue items',
      fields: {
        name:        { type: 'string',  required: true,  maxLength: 200 },
        description: { type: 'text',    required: false, maxLength: 2000 },
        price:       { type: 'number',  required: true,  min: 0 },
        stock:       { type: 'integer', required: true,  min: 0 },
        sku:         { type: 'string',  required: true,  unique: true },
        active:      { type: 'boolean', required: false, default: true },
      },
      rbac: {
        read:   ['customer'],    // everyone logged in can read
        write:  ['manager'],     // managers+ can write
        delete: ['admin'],       // only admins can delete
      },
    },
    {
      name: 'Order',
      description: 'Customer orders',
      fields: {
        customerId: { type: 'uuid',    required: true },
        status:     { type: 'string',  required: true, default: 'pending' },
        totalCents: { type: 'integer', required: true, min: 0 },
        notes:      { type: 'text',    required: false },
      },
      rbac: {
        read:   ['staff'],    // staff+ can read all orders
        write:  ['customer'], // customers can create orders
        delete: ['manager'],  // managers+ can cancel
      },
    },
    {
      name: 'Category',
      description: 'Product categories',
      fields: {
        name:        { type: 'string',  required: true,  unique: true },
        slug:        { type: 'string',  required: true,  unique: true },
        description: { type: 'text',    required: false },
      },
      endpoints: ['list', 'read'],  // public read-only
    },
  ],
})

const { app, prismaSchema, openApiSpec, zodSchemas } = createRuntime(spec)

console.log('=== E-Commerce API ===')
console.log('Roles: admin > manager > staff > customer')
console.log()
console.log('Resources:')
for (const resource of spec.resources) {
  const schemaKeys = Object.keys(zodSchemas[resource.name] ?? {})
  console.log(`  /${resource.name.toLowerCase()}s — schemas: [${schemaKeys.join(', ')}]`)
}
console.log()
console.log('OpenAPI paths:', Object.keys(openApiSpec.paths).join(', '))
console.log()
console.log('--- Prisma Schema (snippet) ---')
console.log(prismaSchema.split('\n').slice(0, 15).join('\n'))
console.log('...')

export { app }
