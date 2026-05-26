# @zeroapi/runtime

Generate a complete, secured, tested REST API from a JSON spec — no scaffolding, no boilerplate.

```ts
import { parseSpec, createRuntime } from '@zeroapi/runtime'

const spec = parseSpec({
  version: '1.0.0',
  name: 'my-api',
  resources: [
    {
      name: 'Post',
      fields: {
        title:   { type: 'string',  required: true },
        content: { type: 'text',    required: false },
        status:  { type: 'string',  required: true, default: 'draft' },
      },
    },
  ],
})

const { app } = createRuntime(spec)
export default app   // Hono app — works on Node, Bun, Cloudflare Workers
```

That's it. You get: `GET/POST /posts`, `GET/PUT/DELETE /posts/:id`, Zod validation, OpenAPI docs at `/docs`.

---

## Features

| Capability | What you get |
|---|---|
| **CRUD routes** | Full REST for every resource, auto-pluralised |
| **Validation** | Zod schemas generated from field definitions |
| **Relations** | manyToOne, oneToMany, manyToMany, oneToOne — Prisma schema + `?include=` |
| **Filtering** | `?field[contains]=`, `[gte]`, `[lte]`, `[in]`, `[startsWith]` … |
| **Sorting** | `?sort=field:asc,field2:desc` (multi-field) |
| **Pagination** | Cursor-based (`?cursor=id&limit=20`) — stable across requests |
| **Transactions** | Spec-level atomic ops (increment, decrement, create, delete) — 409 on failure |
| **File upload** | `file` field type, local / S3 / R2 providers, MIME + size validation |
| **Auth** | JWT middleware, per-resource `auth.required` |
| **RBAC** | Role hierarchy with transitive inheritance, per-resource read/write/delete guards |
| **Security** | Helmet headers, CORS, rate limiting, JSON sanitisation |
| **OpenAPI** | 3.0.3 spec at `/openapi.json`, Scalar UI at `/docs` |
| **Deploy configs** | Railway, Render, Vercel, Fly.io generators included |

---

## Installation

```bash
npm install @zeroapi/runtime
```

Peer dependencies: `hono`, `zod` (already bundled — no manual install needed for typical use).

---

## Quick examples

### Filtering & sorting

```
GET /products?price[lte]=100&status[eq]=active&sort=name:asc&limit=10
GET /products?name[contains]=phone&sort=price:desc,name:asc
GET /products?sku[in]=ELEC-001,ELEC-002,ELEC-003
```

### Relations

```ts
// Spec
relations: [
  { type: 'manyToOne', resource: 'Category', field: 'categoryId' },
]

// Runtime
GET /products?include=Category
// → { data: [{ id: '…', name: '…', category: { id: '…', name: 'Electronics' } }] }
```

### Cursor pagination

```
GET /products?sort=price:asc&limit=5
→ { data: […], nextCursor: 'abc123' }

GET /products?sort=price:asc&limit=5&cursor=abc123
→ { data: […], nextCursor: 'def456' }
```

### Transactions

```ts
// Spec — atomically decrement stock on every purchase POST
transactions: [
  {
    trigger: 'POST',
    operations: [
      { action: 'decrement', resource: 'product', idFrom: 'productId', field: 'stock', amountFrom: 'quantity' },
    ],
  },
]
// If stock would go negative → 409 Conflict, no data changed
```

### File upload

```ts
// Spec
fields: {
  image: { type: 'file', accept: ['image/jpeg', 'image/png'], maxSize: '5MB', storage: 'local' },
}

// Client: POST multipart/form-data
// Response: { data: { id: '…', image: '/uploads/abc123.jpg' } }
```

---

## `createRuntime(spec, options?)`

```ts
const { app, prismaSchema, zodSchemas, openApiSpec, testSuite, spec } =
  createRuntime(spec, {
    enableLogging:  true,   // Hono logger middleware
    enableCors:     true,   // CORS (uses spec.cors config)
    enableHelmet:   true,   // Security headers
    enableSanitize: true,   // JSON injection sanitiser
    enableDocs:     true,   // /docs + /openapi.json
    uploadDir:      '/tmp/uploads',  // local file upload directory
  })
```

---

## Known limitations

These are current design boundaries, not bugs. They will be lifted in future versions.

### 1. Many-to-many filtering is not supported

`?field[op]=value` filters operate on the primary resource's own stored fields. At query time, M2M relation data (e.g. a product's tags) lives in a separate join table and has not yet been resolved. Filtering across join tables requires a pre-join step that is not yet implemented.

**What does NOT work:**
```
GET /products?tags[has]=electronics      ← no "has" operator
GET /products?tags[contains]=sale        ← tags not in filter scope
```

**Workaround:** Fetch with `?include=Tag` and filter client-side, or query the join resource directly.

### 2. Cursor pagination with non-unique sort keys

When using `?sort=price:asc&cursor=xxx`, items are sorted first, then the cursor locates the last-seen item by `id` in the sorted array. This is correct.

**Edge case:** If multiple items share the same sort-key value (e.g., three products all priced at `9.99`) and that group straddles a page boundary, their relative order among equals is not guaranteed to be identical across two separate requests. You may occasionally see a duplicate or a missing item at the boundary.

**Fix (recommended):** Always add `id` as a secondary sort to force a stable total order:
```
GET /products?sort=price:asc,id:asc&limit=20
```
The `id` field is always unique, so this eliminates the ambiguity entirely.

### 3. Nested creation: depth 1 only

**Supported nested creation (depth 1, manyToMany only):**
```jsonc
POST /articles
{
  "headline": "Breaking News",
  "categories": [             // ← manyToMany nested array (use plural form of resource name)
    { "categoryId": "xxx", "position": 1 }   // related record must already exist
  ]
}
```
The items in the nested array are **join records**, not new resources. You pass the ID of an already-existing record. Recursive nesting (creating a new Category inside the Article body) is not supported.

**Atomic rollback:** If any nested join record references an ID that does not exist in the store, the entire request is rolled back (including the main record) and a 409 is returned. The spec-level `transactions` block (e.g. stock decrement) runs before nested persistence; if the transaction fails, neither the main record nor join records are written.

**In production with Prisma:** All steps would be inside a single `prisma.$transaction()` call.

### 4. In-memory store only (v0.1.0)

The runtime uses an in-memory `Map`-based store. All data is lost on process restart. The generated `prismaSchema` is ready for Prisma + a real database; the in-memory store is for prototyping, testing, and CI.

### 5. File upload: local provider saves to disk

The `local` storage provider writes files to `uploadDir` on the server filesystem and returns a `/uploads/<filename>` URL. You must serve that directory statically yourself (e.g. `app.use('/uploads', serveStatic({ root: uploadDir }))` with Hono's static middleware). The `s3`/`r2` providers return a presigned PUT URL — the client is responsible for the actual upload to the bucket.

### 6. Auth flows use in-memory user store

`POST /auth/register`, `/auth/login`, etc. persist users in-memory alongside the resource store. All session data (users, tokens, refresh tokens) is lost on restart. The `emailVerification` flow returns the token in the API response for testability; in production you would send the token via email. A persistent auth adapter (e.g. Prisma-backed) is on the roadmap.

### 7. Rate limiter: MemoryStore is single-instance only

The default `MemoryRateLimitStore` is process-local — it does not share state across multiple instances of the same service. For multi-instance deployments, pass a `RedisRateLimitStore` (or any `RateLimitStore` implementation) via `createRuntime({ rateLimitStore })`.

### 8. Custom hook mutations must modify the input object in-place

`beforeCreate` and `beforeUpdate` hooks receive an `input` object. To change what gets persisted, mutate the object directly (e.g. `input.status = 'active'`). Replacing the object reference (`input = { ... }`) has no effect because the framework holds a reference to the original object, not the parameter binding.

### 9. afterCreate / afterUpdate / afterDelete are fire-and-forget

Failures in after-hooks are silently discarded. If you need guaranteed delivery (e.g. send email after every registration), pair the hook with a job queue outside the runtime.

---

## Spec DSL reference

See [src/types/spec.ts](./src/types/spec.ts) for the full TypeScript interface.

Key types: `ZeroAPISpec`, `ResourceDefinition`, `FieldDefinition`, `RelationDefinition`, `TransactionConfig`, `TxOperation`, `AuthConfig`, `RoleDefinition`.

---

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest watch
npm run test:run    # vitest run (CI)
npm run build       # tsup → dist/
```

314 tests across 27 test files.

---

## License

MIT © Ludovic Aggaï NGABANG
