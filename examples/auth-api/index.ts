/**
 * Auth API example — JWT authentication, configurable CORS, rate limiting.
 * Run with: npx tsx examples/auth-api/index.ts
 */
import { parseSpec, createRuntime } from '../../src/index.js'

const spec = parseSpec({
  version: '1.0.0',
  name: 'auth-api',
  description: 'API with JWT authentication, CORS, and rate limiting',
  auth: {
    strategy: 'jwt',
    secret: process.env['JWT_SECRET'] ?? 'dev-secret-change-in-production',
  },
  cors: {
    origins: ['https://app.example.com', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    headers: ['Content-Type', 'Authorization'],
    credentials: true,
  },
  rateLimit: {
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 100,                   // 100 requests per window per IP
    byUser: true,               // Also limit per JWT user
    message: 'Rate limit exceeded — please retry in 15 minutes',
  },
  security: {
    hsts: true,
    noSniff: true,
    frameguard: 'DENY',
    contentSecurityPolicy: true,
  },
  resources: [
    {
      name: 'Profile',
      description: 'User profiles (requires auth)',
      fields: {
        username:  { type: 'string', required: true, unique: true, minLength: 3, maxLength: 30 },
        bio:       { type: 'text',   required: false, maxLength: 500 },
        avatarUrl: { type: 'url',    required: false },
        isPublic:  { type: 'boolean', required: false, default: true },
      },
      auth: { required: true },
    },
    {
      name: 'Post',
      description: 'Blog posts (requires auth to write)',
      fields: {
        title:     { type: 'string',  required: true, minLength: 1, maxLength: 200 },
        content:   { type: 'text',    required: true },
        published: { type: 'boolean', required: false, default: false },
        tags:      { type: 'string',  required: false },
      },
      auth: { required: true },
    },
  ],
})

const { app, openApiSpec } = createRuntime(spec)

// Protected routes (require Authorization: Bearer <jwt>):
//   GET    /profiles
//   POST   /profiles
//   GET    /profiles/:id
//   PUT    /profiles/:id
//   DELETE /profiles/:id
//   GET    /posts  ... etc.

console.log('=== Auth API ===')
console.log('Auth: JWT Bearer token')
console.log('Rate limit: 100 req / 15 min per IP')
console.log('OpenAPI paths:', Object.keys(openApiSpec.paths).join(', '))

export { app }
