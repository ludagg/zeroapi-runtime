/**
 * Phase 1 Auth — e2e validation demo server.
 *
 * Boots a real HTTP server on PORT (default 3030) wired with:
 *   - JWT user system (register/login/refresh/me/logout)
 *   - API-key auth (admin endpoints)
 *   - In-memory stores (so we can pre-bootstrap admin + vendors)
 *   - Permissions: Product (public read, admin all, vendor own-only)
 *                  Order   (user create/read own-only, admin all)
 *
 * Emits one READY {...} line on stdout once HTTP is listening:
 *   bootstrapKey, adminToken, vendorAToken, vendorBToken — used by the
 *   validation script to drive the 17 scenarios.
 */
import { serve } from '@hono/node-server'
import {
  parseSpec,
  createRuntime,
  MemoryUserStore,
  MemoryRefreshTokenStore,
  MemoryApiKeyStore,
  generateAccessToken,
  resolveJwtSecret,
} from '../src/index.js'

process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'phase1-e2e-secret-do-not-use-in-prod'

const spec = parseSpec({
  version: '1.0.0',
  name: 'shop',
  description: 'Phase 1 Auth e2e validation shop',
  auth: {
    enabled: true,
    strategies: ['jwt', 'apikey'],
    jwt: { enabled: true, secretEnv: 'JWT_SECRET' },
    apikey: { enabled: true },
  },
  resources: [
    {
      name: 'Product',
      fields: {
        title: { type: 'string', required: true },
        price: { type: 'number', required: false },
      },
    },
    {
      name: 'Order',
      fields: {
        productTitle: { type: 'string', required: true },
        quantity: { type: 'integer', required: true, default: 1 },
      },
    },
  ],
  permissions: [
    {
      resource: 'Product',
      rules: [
        { role: 'public', actions: ['read'] },
        { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
        { role: 'vendor', actions: ['create', 'read', 'update'], ownOnly: true },
      ],
    },
    {
      resource: 'Order',
      rules: [
        { role: 'user', actions: ['create', 'read'], ownOnly: true },
        { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
      ],
    },
  ],
})

const userStore = new MemoryUserStore()
const refreshTokenStore = new MemoryRefreshTokenStore()
const apiKeyStore = new MemoryApiKeyStore()

let bootstrapKey = ''
const apiKeyBootstrapLogger = (line: string) => {
  const match = line.match(/(zak_[a-z]+_[A-Za-z0-9_-]+)/)
  if (match) bootstrapKey = match[1]
}

const { app } = createRuntime(spec, {
  enableLogging: false,
  enableDocs: false,
  enableHelmet: false,
  enableCors: false,
  enableSanitize: false,
  userStore,
  refreshTokenStore,
  apiKeyStore,
  apiKeyBootstrapLogger,
  jwtSecretLogger: () => { /* silent */ },
})

async function bootstrap() {
  const admin = await userStore.create({
    email: 'admin@shop.test',
    passwordHash: 'irrelevant',
    salt: 'irrelevant',
    role: 'admin',
  })
  const vendorA = await userStore.create({
    email: 'vendor-a@shop.test',
    passwordHash: 'irrelevant',
    salt: 'irrelevant',
    role: 'vendor',
  })
  const vendorB = await userStore.create({
    email: 'vendor-b@shop.test',
    passwordHash: 'irrelevant',
    salt: 'irrelevant',
    role: 'vendor',
  })

  const secret = resolveJwtSecret(spec.auth!, () => { /* silent */ })
  const adminToken = await generateAccessToken(admin.id, admin.email, 'admin', secret, 3600)
  const vendorAToken = await generateAccessToken(vendorA.id, vendorA.email, 'vendor', secret, 3600)
  const vendorBToken = await generateAccessToken(vendorB.id, vendorB.email, 'vendor', secret, 3600)

  return {
    adminToken,
    vendorAToken,
    vendorBToken,
    adminId: admin.id,
    vendorAId: vendorA.id,
    vendorBId: vendorB.id,
  }
}

const port = Number(process.env['PORT'] ?? 3030)

bootstrap().then((extras) => {
  serve({ fetch: app.fetch, port }, () => {
    const meta = { port, bootstrapKey, ...extras }
    process.stdout.write('READY ' + JSON.stringify(meta) + '\n')
  })
})
