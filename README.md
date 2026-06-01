<div align="center">

<img src="https://raw.githubusercontent.com/ludagg/zeroapi-runtime/main/assets/banner.png" alt="zeroapi-runtime — the spec is the source of truth, no drift" width="640" />

# @ludagg/zeroapi-runtime

**Generate a complete, production-ready backend API from a single JSON spec.**
*The spec is the source of truth. No drift.*

[![npm version](https://img.shields.io/npm/v/@ludagg/zeroapi-runtime.svg)](https://www.npmjs.com/package/@ludagg/zeroapi-runtime)
[![license](https://img.shields.io/npm/l/@ludagg/zeroapi-runtime.svg)](#license)
[![tests](https://img.shields.io/badge/tests-1075%20passing-brightgreen.svg)](#development)
[![proven on PostgreSQL](https://img.shields.io/badge/proven%20on-real%20PostgreSQL-336791.svg)](./REAL_DB_TEST.md)

</div>

You describe **what** your API contains — resources, fields, relations, auth, permissions — in one declarative **Spec (DSL)**. The runtime produces the whole backend: CRUD routes, validation, authentication, RBAC, relations, webhooks, OpenAPI docs, and more.

Hand-written backends drift from their design the moment you start typing. ZeroAPI removes the gap: the spec **is** the running API, so the contract and the implementation can never disagree. It's not a scaffolder you run once and edit — it's a runtime engine you keep feeding the spec.

- 🧩 **Spec-driven** — one JSON object describes the entire API surface; no boilerplate to maintain.
- 🚀 **Production-ready** — SQL-pushdown queries, revocable JWT auth, durable + encrypted webhooks, multi-tenant isolation, graceful shutdown — not a toy.
- 🪶 **Portable** — built on [Hono](https://hono.dev), so the same app runs unchanged on **Node.js, Bun, Deno, and Cloudflare Workers**.
- 🧪 **Proven** — **1075 tests**, and every database-mode feature verified against **real PostgreSQL** (not a mock).

```ts
import { parseSpec, createRuntime } from '@ludagg/zeroapi-runtime'

const spec = parseSpec({
  version: '1.0.0',
  name: 'my-api',
  resources: [
    {
      name: 'Post',
      fields: {
        title:   { type: 'string', required: true },
        content: { type: 'text',   required: false },
        status:  { type: 'enum',   values: ['draft', 'published'], default: 'draft' },
      },
    },
  ],
})

const { app } = createRuntime(spec)
export default app   // a Hono app — runs on Node, Bun, Deno, Cloudflare Workers
```

That's the whole backend. You get `GET/POST /posts`, `GET/PUT/DELETE /posts/:id`, Zod validation on every write, filtering/sorting/search/pagination, interactive OpenAPI docs at `/docs`, and `/health` + `/ready` probes — in memory for prototyping, or backed by Postgres (Prisma) for production with **zero route changes**.

---

## Table of contents

- [Why ZeroAPI](#why-zeroapi)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Feature overview](#feature-overview)
- [The Spec DSL](#the-spec-dsl)
  - [Field types](#field-types)
  - [Resources](#resources)
  - [Relations](#relations)
  - [Transactions](#transactions)
  - [Features block](#features-block)
- [Querying: filter, sort, search, paginate](#querying-filter-sort-search-paginate)
- [Authentication](#authentication)
  - [JWT user system](#jwt-user-system)
  - [API keys](#api-keys)
  - [OAuth](#oauth)
- [Authorization (RBAC & permissions)](#authorization-rbac--permissions)
- [State machines (workflows)](#state-machines-workflows)
- [Aggregates](#aggregates)
- [File upload & storage](#file-upload--storage)
- [Webhooks](#webhooks)
- [Lifecycle hooks & custom endpoints](#lifecycle-hooks--custom-endpoints)
- [Security](#security)
- [Observability](#observability)
- [Environment variables](#environment-variables)
- [Persistence (in-memory vs Prisma)](#persistence-in-memory-vs-prisma)
- [Generated artifacts](#generated-artifacts)
- [`createRuntime` reference](#createruntimespec-options-reference)
- [Built-in endpoints](#built-in-endpoints)
- [Examples](#examples)
- [Known limitations](#known-limitations)
- [Proven on real PostgreSQL](#proven-on-real-postgresql)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

---

## Why ZeroAPI

Building a production REST API means writing the same plumbing over and over: routing, input validation, auth, role checks, pagination, docs, rate limiting, security headers. ZeroAPI treats that plumbing as a **function of your data model**.

- **Declarative** — one Spec describes the whole API surface.
- **Batteries included** — auth, RBAC, webhooks, uploads, docs, deploy configs all ship in the box.
- **Scales in Prisma mode** — filtering, full-text search, sorting and pagination are pushed down to a single SQL query (`WHERE`/`ORDER BY`/`LIMIT`/`OFFSET` + a real `COUNT`); the database never ships the whole table to Node. Nested routes, many-to-many writes, and `onDelete` cascades all run in the DB (the cascade atomically, in one `$transaction`).
- **Secure by default** — JWT verification fails closed (a token is refused when there is no secret to verify it), access tokens are revocable (logout / user deletion cut live sessions), and `/auth/login` + `/auth/register` are rate-limited per IP.
- **Operations-ready** — webhooks persist to the database and resume after restart (no double-delivery across instances), `?include=` depth is capped, `/ready` runs a real DB probe (`503` when the database is down), and `shutdown()` stops the worker and disconnects cleanly.
- **Multi-tenant ready** — declare tenant isolation in the spec (`scope` by column ↔ JWT claim); the runtime enforces it on every read/write, no per-route code.
- **Workflow-ready** — declare state machines (`stateMachine`) over an enum field; the runtime enforces allowed transitions and which roles may perform them.
- **Business logic, declared not coded** — multi-tenant scope, state-machine workflows, and relation aggregates (`count`/`sum`/`avg`/`min`/`max`) all live in the spec and run in both memory and Prisma modes.
- **Portable** — one Hono app for every JS runtime.
- **Typed** — the Spec is fully typed; generators emit Zod schemas, a Prisma schema, a TypeScript SDK, and an OpenAPI 3.0 document.
- **Tested** — 1075 tests across 70 files cover every subsystem.
- **Incremental** — start in-memory for prototyping, drop in Prisma-backed stores for production with zero route changes.

---

## Installation

```bash
npm install @ludagg/zeroapi-runtime
# or
pnpm add @ludagg/zeroapi-runtime
# or
bun add @ludagg/zeroapi-runtime
```

`hono` and `zod` are regular dependencies and install automatically. The only **optional peer dependency** is `@aws-sdk/client-s3`, required solely if you use the S3/R2 storage provider:

```bash
npm install @aws-sdk/client-s3
```

**Requirements:** Node.js `>= 18`.

---

## Quick start

### 1. Define a spec and create the runtime

```ts
import { parseSpec, createRuntime } from '@ludagg/zeroapi-runtime'

const spec = parseSpec({
  version: '1.0.0',
  name: 'blog-api',
  resources: [
    {
      name: 'Post',
      fields: {
        title:   { type: 'string', required: true, minLength: 1, maxLength: 200 },
        content: { type: 'text',   required: false },
        status:  { type: 'enum',   values: ['draft', 'published'], default: 'draft' },
      },
    },
  ],
})

const { app } = createRuntime(spec)
```

### 2. Serve it on your runtime of choice

**Node.js** (`@hono/node-server`):

```ts
import { serve } from '@hono/node-server'
serve({ fetch: app.fetch, port: 3000 })
```

**Bun:**

```ts
export default { fetch: app.fetch, port: 3000 }
```

**Cloudflare Workers / Deno:**

```ts
export default app   // exports a `fetch` handler
```

### 3. Use the API

```bash
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{ "title": "Hello ZeroAPI" }'

curl 'http://localhost:3000/posts?status[eq]=draft&sort=createdAt:desc&limit=10'
```

Open `http://localhost:3000/docs` for the interactive API reference.

---

## Feature overview

| Capability | What you get |
|---|---|
| **CRUD routes** | Full REST for every resource, auto-pluralised (`Post` → `/posts`) |
| **Validation** | Zod schemas generated from field definitions, applied on every write |
| **Relations** | `manyToOne`, `oneToMany`, `manyToMany`, `oneToOne` — Prisma schema + nested `?include=` (depth-capped), atomic `onDelete` cascade |
| **Querying (SQL pushdown)** | Filter (`[eq] [ne] [gt] [gte] [lt] [lte] [contains] [startsWith] [endsWith] [in] [notin]`), sort, search (`?q=`), pagination — all pushed to a single SQL query in Prisma mode (no full-table scans) |
| **Pagination** | Cursor (`?cursor=`) **and** offset (`?page=`), with a real SQL `COUNT` |
| **Soft delete** | `softDelete: true` → `DELETE` sets `deletedAt`; reads hide it; `?includeDeleted=true` to opt back in |
| **Transactions** | Spec-level atomic ops (increment, decrement, create, delete) — `409` on failure; ACID in Prisma, serialized in memory |
| **File upload** | `file` / `file[]` field types, local / S3 / R2 providers, MIME + size validation |
| **Webhooks** | Outbound HMAC-signed events with retry — **durable** (survive restart, no double-delivery), **secrets encrypted at rest**; inbound signature verification |
| **Auth — JWT** | Full user system: register, login, refresh, logout, `/auth/me` — **access tokens are revocable** (logout / user deletion cut sessions) |
| **Auth — API keys** | Hashed keys, admin management routes, bootstrap on first boot |
| **Auth — OAuth** | Google, GitHub, Apple authorization-code flow with account linking |
| **Auth flows** | Email verification, password reset, refresh rotation, revocation, lockout |
| **RBAC** | Role hierarchy with transitive inheritance, per-resource read/write/delete guards |
| **Permissions** | Declarative per-role rules, including row-level `ownOnly` ownership |
| **Multi-tenant** | Declarative tenant isolation via `scope` (column ↔ JWT claim) — reads scoped, writes forced to the tenant, cross-tenant access 404s |
| **State machines** | Declarative `stateMachine` on an enum field — allowed transitions + per-role gating, enforced on update (`409`/`403`) |
| **Aggregates** | Declarative `count` / `sum` / `avg` / `min` / `max` over relations, opt-in via `?include=` — batched (no N+1) |
| **Security** | Helmet headers, CORS, rate limiting (memory or Redis), JSON sanitisation, per-IP rate limit on `/auth/login` + `/auth/register` |
| **OpenAPI** | 3.0.3 spec at `/openapi.json`, Scalar UI at `/docs` |
| **Postman** | Generate a Postman v2.1 collection from the spec |
| **SDK generation** | Emit a typed TypeScript client for the API |
| **Observability** | Request-ID middleware, structured logger, `/health` (uptime), `/ready` (**real DB probe** → `503` when the DB is down) |
| **Graceful shutdown** | `shutdown()` stops the webhook worker + disconnects Prisma; opt-in `SIGTERM`/`SIGINT` binding |
| **Env management** | Aggregate required env vars, generate `.env.example`, validate at boot |
| **Schema migration** | Opt-in, non-destructive helpers — `writePrismaSchema`, `pushPrismaSchema` (dev), `deployPrismaMigrations` (prod) |
| **Deploy configs** | Railway, Render, Vercel, Fly.io generators + deploy buttons |
| **Persistence** | In-memory by default; Prisma-backed stores for production (resources, auth, webhooks) |

---

## The Spec DSL

The Spec is a plain JSON object validated by `parseSpec()`. The full TypeScript interface lives in [`src/types/spec.ts`](./src/types/spec.ts) — `ZeroAPISpec` is the root.

```ts
interface ZeroAPISpec {
  version: string
  name: string
  description?: string
  baseUrl?: string
  auth?: GlobalAuthConfig
  roles?: RoleDefinition[]
  rateLimit?: RateLimitConfig
  cors?: CorsConfig
  security?: SecurityConfig
  resources: ResourceDefinition[]
  authFlows?: AuthFlowsConfig
  requiredEnv?: string[]
  relations?: SpecRelation[]      // top-level cross-resource relations
  env?: EnvVarDefinition[]        // declared environment variables
  permissions?: PermissionDefinition[]
  features?: FeaturesConfig       // uploads, webhooks, search, pagination, rate limit
}
```

`parseSpec()` validates structure, fills defaults, and throws a `ParseError` with a clear message on invalid input. Always run your spec through it before passing it to `createRuntime`.

### Field types

| Type | Maps to | Notes |
|---|---|---|
| `string` | `String` | `minLength` / `maxLength` |
| `text` | `String` | long text |
| `number` / `decimal` | `Float` | `min` / `max` |
| `integer` | `Int` | `min` / `max` |
| `boolean` | `Boolean` | |
| `date` / `datetime` | `DateTime` | ISO-8601 |
| `email` | `String` | validated as email |
| `url` | `String` | validated as URL |
| `uuid` | `String` | validated as UUID |
| `enum` | `String` | requires `values: string[]` |
| `json` | `Json` | arbitrary object |
| `file` / `file[]` | `String` (URL) | `accept`, `maxSize`, `storage`, `multiple` |

Every field supports `required`, `unique`, `index`, `default`, and `description`.

```ts
fields: {
  email:  { type: 'email',  required: true, unique: true },
  age:    { type: 'integer', min: 0, max: 130 },
  role:   { type: 'enum',   values: ['user', 'admin'], default: 'user' },
  avatar: { type: 'file',   accept: ['image/png', 'image/jpeg'], maxSize: '5MB', storage: 'local' },
}
```

### Resources

```ts
interface ResourceDefinition {
  name: string
  description?: string
  fields: Record<string, FieldDefinition>
  endpoints?: ('list' | 'create' | 'read' | 'update' | 'delete')[]  // default: all
  auth?: { required: boolean; roles?: string[]; strategy?: 'jwt' | 'apikey' | 'bearer' }
  hooks?: ResourceHooks
  rbac?: { read?: string[]; write?: string[]; delete?: string[] }
  relations?: RelationDefinition[]
  transactions?: TransactionConfig[]
  customEndpoints?: CustomEndpointDef[]
  softDelete?: boolean      // keep rows, set deletedAt instead of removing
  timestamps?: boolean      // auto createdAt/updatedAt (default: true)
  searchable?: string[]     // fields indexed for ?q= search
}
```

Restrict the generated routes with `endpoints`:

```ts
{ name: 'AuditLog', fields: { … }, endpoints: ['list', 'read'] }  // read-only resource
```

### Relations

Define relations per resource (legacy form) or at the top level via `spec.relations`.

```ts
relations: [
  // belongs-to: stores categoryId on this resource
  { type: 'manyToOne', resource: 'Category', field: 'categoryId', onDelete: 'SetNull' },

  // many-to-many through a join table, with extra fields on the join row
  { type: 'manyToMany', resource: 'Tag', through: 'product_tags', fields: { position: { type: 'integer' } } },
]
```

Resolve related data at query time with `?include=`:

```
GET /products?include=Category
→ { data: [{ id: '…', name: '…', category: { id: '…', name: 'Electronics' } }] }
```

The generated Prisma schema wires the foreign keys and join models automatically. `onDelete` accepts `Cascade`, `SetNull`, `Restrict`, or `NoAction`.

### Transactions

Declare atomic, spec-level side effects that fire on a given HTTP verb. If any operation fails (e.g. stock would go negative), the whole request is rolled back and a `409 Conflict` is returned.

```ts
transactions: [
  {
    trigger: 'POST',
    operations: [
      // atomically decrement product.stock by the request's `quantity`
      { action: 'decrement', resource: 'product', idFrom: 'productId', field: 'stock', amountFrom: 'quantity' },
    ],
  },
]
```

Supported actions: `create`, `update`, `delete`, `increment`, `decrement`. Amounts can be static (`amount`) or read from the request body (`amountFrom`).

### Features block

Cross-cutting features are toggled under `spec.features`:

```ts
features: {
  fileUpload: { enabled: true, provider: 'local', maxSizeMB: 5, allowedTypes: ['image/png'] },
  webhooks:   { outbound: ['order.created'], inbound: ['stripe.payment'] },
  search:     { enabled: true, fuzzy: false },
  pagination: { defaultLimit: 20, maxLimit: 100 },
  rateLimit:  { perKey: '1000/h', public: '60/m' },
}
```

---

## Querying: filter, sort, search, paginate

All list endpoints accept query parameters for filtering, sorting, search, and pagination.

### Filtering

```
GET /products?price[lte]=100&status[eq]=active
GET /products?name[contains]=phone
GET /products?sku[in]=ELEC-001,ELEC-002,ELEC-003
GET /products?name[startsWith]=Pro
```

Supported operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `in`, `notin`.

> **In Prisma mode, all of this is pushed down to SQL** — filtering, search, sorting and pagination become one `WHERE / ORDER BY / LIMIT / OFFSET` query plus a real `COUNT(*)`. The database never ships the whole table to Node, and filter values are coerced to the column type. Unknown fields/operators are rejected with a `400` before any query runs.

### Sorting

```
GET /products?sort=price:desc
GET /products?sort=price:desc,name:asc        # multi-field
```

### Full-text search

When a resource declares `searchable` fields and `features.search.enabled` is `true`:

```
GET /products?q=wireless        # case-insensitive substring match across searchable fields
```

### Pagination (cursor or offset)

```
# cursor — keyset, stable for infinite scroll
GET /products?sort=price:asc&limit=5
→ { data: [...], count: 42, pagination: {…}, nextCursor: 'abc123' }
GET /products?sort=price:asc&limit=5&cursor=abc123
→ { data: [...], nextCursor: 'def456' }

# offset — classic page numbers
GET /products?page=3&limit=20
→ { data: [...], count: 42, pagination: { page: 3, totalPages: 3, hasNext: false, … } }
```

> **Tip:** add `id` as a secondary sort key (`?sort=price:asc,id:asc`) to guarantee a stable total order across pages — see [Known limitations](#known-limitations).

---

## Authentication

ZeroAPI supports three authentication strategies that can be combined: a **JWT user system**, **API keys**, and **OAuth**. Configure them under `spec.auth`. Per-resource access is then gated with `auth: { required: true }`.

The `auth` block accepts both a **legacy single-strategy** shape and a **modern multi-strategy** shape:

```ts
// Modern multi-strategy
auth: {
  enabled: true,
  strategies: ['jwt', 'apikey', 'oauth'],
  jwt:    { enabled: true, accessTokenTTL: '15m', refreshTokenTTL: '30d', secretEnv: 'JWT_SECRET' },
  apikey: { enabled: true, header: 'X-API-Key', prefix: 'zk_' },
  oauth:  { providers: [{ name: 'google', clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' }] },
  emailVerification: true,
  passwordReset: true,
}

// Legacy single-strategy
auth: { strategy: 'jwt', secret: process.env.JWT_SECRET }
```

### JWT user system

Set `auth.jwt.enabled = true` to mount a complete user system. The JWT secret is read from `auth.jwt.secretEnv` (default `JWT_SECRET`); in dev an ephemeral secret is generated with a warning.

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/auth/register` | `{ email, password }` | Create a user |
| `POST` | `/auth/login` | `{ email, password }` | Returns access + refresh tokens |
| `POST` | `/auth/refresh` | `{ refreshToken }` | Rotate the access token |
| `POST` | `/auth/logout` | `{ refreshToken }` | Revoke the refresh token |
| `GET`  | `/auth/me` | — | Current user (requires `Authorization: Bearer …`) |

Protected routes expect `Authorization: Bearer <accessToken>`.

### API keys

Set `auth.apikey.enabled = true` (or `auth.strategy = 'apikey'`). Keys are **hashed at rest**; the plaintext value is shown **only once** at creation. Admin routes (protected by the auth middleware) manage the lifecycle:

| Method | Path | Description |
|---|---|---|
| `POST`   | `/admin/api-keys` | Create a key (returns plaintext once) |
| `GET`    | `/admin/api-keys` | List keys (metadata only) |
| `DELETE` | `/admin/api-keys/:id` | Revoke a key |

Clients send the key in the configured header (default `X-API-Key`). A bootstrap key can be provisioned automatically on first boot.

### OAuth

Add providers under `auth.oauth.providers` (requires the JWT user system to be enabled, since OAuth issues the same tokens). Supported: `google`, `github`, `apple`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/oauth/:provider` | Redirect to the provider's consent screen |
| `GET` | `/auth/oauth/:provider/callback` | Exchange the code, link the account, issue tokens |

Set the callback base URL via `OAUTH_CALLBACK_BASE_URL`, and each provider's credentials via the `clientIdEnv` / `clientSecretEnv` you declared.

### Auth flows

`spec.authFlows` enables additional flows (when not already covered by the JWT user system):

```ts
authFlows: {
  emailVerification: true,   // POST /auth/verify-email
  passwordReset: true,       // POST /auth/forgot-password + /auth/reset-password
  refreshTokens: true,       // POST /auth/refresh
  revocation: true,          // POST /auth/logout
  lockout: { maxAttempts: 5, windowMs: 15 * 60 * 1000 },
}
```

---

## Authorization (RBAC & permissions)

### Role hierarchy

Declare roles with transitive inheritance — a role automatically gains the permissions of everything it `inherits`:

```ts
roles: [
  { name: 'admin',    inherits: ['manager'] },
  { name: 'manager',  inherits: ['staff'] },
  { name: 'staff',    inherits: ['customer'] },
  { name: 'customer' },
]
```

### Per-resource guards

Gate each action with `rbac`:

```ts
{
  name: 'Product',
  fields: { … },
  rbac: {
    read:   ['customer'],   // customer and everything that inherits it
    write:  ['manager'],
    delete: ['admin'],
  },
}
```

### Declarative permissions (with ownership)

`spec.permissions` expresses role rules declaratively, including **row-level ownership** via `ownOnly` — a requester can only touch rows they own:

```ts
permissions: [
  {
    resource: 'Order',
    rules: [
      { role: 'customer', actions: ['create', 'read'], ownOnly: true },
      { role: 'admin',    actions: ['create', 'read', 'update', 'delete'] },
    ],
  },
]
```

### Multi-tenant scope

`scope` generalises `ownOnly` from a hard-coded `userId` to **any column matched
against a JWT claim** — the declarative way to isolate tenants (organisations,
workspaces, …). It works identically in memory and Prisma modes (in Prisma mode
the filter is pushed to the database, so other tenants' rows never leave it).

```ts
permissions: [
  {
    resource: 'Document',
    rules: [
      // a member sees/edits only their organisation's documents
      { role: 'member', actions: ['create', 'read', 'update', 'delete'],
        scope: { column: 'organizationId', claim: 'org' } },
    ],
  },
]
// ownOnly is just sugar for: scope: { column: 'userId', claim: 'sub' }
```

The runtime then, for that role:

- **read / list** — returns only rows where `organizationId` equals the token's `org` claim;
- **create** — forces `organizationId` to the claim value (a member of org A cannot write into org B, even if the body says so);
- **update / delete** — a row outside the caller's scope returns **404** (existence is never leaked);
- a token missing the `org` claim is rejected with **403**.

---

## State machines (workflows)

Declare a `stateMachine` over an existing **enum** field to enforce a workflow:
which `from → to` transitions are allowed, and which roles may perform them. The
runtime forces the `initial` state on create and validates every state change on
update — in both memory and Prisma modes (the current state is read before
validating).

```ts
{
  name: 'Post',
  fields: { status: { type: 'enum', values: ['draft', 'published', 'archived'], default: 'draft' } },
  stateMachine: {
    field: 'status',
    initial: 'draft',
    transitions: [
      { from: 'draft',     to: 'published', roles: ['editor', 'admin'] },
      { from: 'published', to: 'archived',  roles: ['admin'] },
      { from: 'archived',  to: 'draft',     roles: ['admin'] },
    ],
  },
}
```

- **create** — the field is forced to `initial` (a client cannot create a row directly in a later state);
- **update** changing the field — `from` is the persisted value, `to` the requested one. A transition that isn't listed returns **409**; a listed transition the caller's role isn't allowed to perform returns **403**;
- **update** not touching the field — unconstrained.

It reuses the existing `enum` and RBAC roles — no new role system. Conditional
guards ("publish only if X is set") and side-effects (send an email on
transition) stay in `hooks` / `transactions` / `webhooks`.

---

## Aggregates

Declare read-only aggregates over a `oneToMany` relation. They are **opt-in** —
computed only when their name appears in `?include=`, so plain reads stay lean.

```ts
{
  name: 'User',
  relations: [{ type: 'oneToMany', resource: 'Order' }],
  aggregates: [
    { name: 'orderCount', op: 'count', relation: 'orders' },
    { name: 'totalSpent', op: 'sum',   relation: 'orders', field: 'total' },
    { name: 'avgOrder',   op: 'avg',   relation: 'orders', field: 'total' },
  ],
}
```

```bash
curl '/users/123?include=orderCount,totalSpent'
# → { "data": { "id": "123", "name": "Ada", "orderCount": 3, "totalSpent": 60 } }
```

- Operators: `count` / `sum` / `avg` / `min` / `max` — a **closed set** (no custom
  expressions). `field` is required for everything except `count`, and must be
  numeric for `sum` / `avg`.
- **Batched, no N+1**: for a list of N rows, each relation is resolved with a
  single Prisma `groupBy` (`fk IN (pageIds)`) — the query count grows with the
  number of distinct relations, never with N. In memory mode it folds over the
  child collection.
- Rows with no children return `0` for `count`/`sum` and `null` for
  `avg`/`min`/`max`.

---

## File upload & storage

Enable uploads via `features.fileUpload` and declare `file` / `file[]` fields. Clients send `multipart/form-data`; the runtime validates MIME type and size, stores the file, and persists a URL.

```ts
features: { fileUpload: { enabled: true, provider: 'local', maxSizeMB: 5, allowedTypes: ['image/jpeg', 'image/png'] } }

// resource field
fields: { image: { type: 'file', accept: ['image/jpeg', 'image/png'], maxSize: '5MB', storage: 'local' } }
```

**Providers:**

- **`local`** — writes to `uploadDir` (default `./uploads`) and serves files at `GET /uploads/:key`. Emits a loud warning if used with `NODE_ENV=production` (files are lost on ephemeral containers).
- **`s3` / `r2`** — requires `@aws-sdk/client-s3`. Reads `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, plus optional `S3_ENDPOINT`, `S3_REGION`, `S3_PUBLIC_URL`.

Pass an explicit provider via `createRuntime(spec, { storageProvider })` to override auto-resolution.

---

## Webhooks

Enable via `features.webhooks`:

```ts
features: {
  webhooks: {
    outbound: ['order.created', 'order.updated'],   // events the API emits
    inbound:  ['stripe.payment'],                   // signed events the API receives
  },
}
```

**Outbound.** The runtime:

- Mounts admin routes — `POST /admin/webhooks`, `GET /admin/webhooks`, `DELETE /admin/webhooks/:id`, `GET /admin/webhooks/:id/deliveries` — to manage endpoints. Secrets are returned **only** at creation.
- Runs an in-process worker that POSTs queued events to each subscribed endpoint with `X-Webhook-Signature` (HMAC-SHA256 of the JSON body), `X-Webhook-Event`, and `X-Webhook-Id`. Failed deliveries retry with exponential backoff (30s → 30min cap, 5 attempts by default).
- **Durable in production** — with Prisma, endpoints and the delivery queue persist to the database (auto-wired), so they **survive a restart** and the worker resumes pending deliveries. The claim is locked atomically, so running multiple replicas **never double-delivers** an event.
- **Secrets encrypted at rest** — set `WEBHOOK_SECRET_ENCRYPTION_KEY` (or `webhookSecretEncryptionKey`) and signing secrets are stored AES-256-GCM-encrypted (`enc:v1:…`), decrypted only to sign. Without a key they stay in clear (with a warning); pre-existing plaintext secrets keep working — no migration.
- Stop cleanly via `await runtime.shutdown()` (also disconnects Prisma).

**Inbound.** Mounts `POST /webhooks/inbound/:source` per declared source. Verifies the HMAC signature against `${SOURCE}_WEBHOOK_SECRET` (mismatch → `401`). Provider-specific headers (e.g. `Stripe-Signature`) can be wired via the `webhookInboundSources` option.

---

## Lifecycle hooks & custom endpoints

### Hooks

Attach business logic to a resource's lifecycle. Hook IDs reference functions in the `handlers` map passed to `createRuntime`.

```ts
// spec
hooks: { beforeCreate: 'purchaseBeforeCreate', afterCreate: 'purchaseAfterCreate' }

// runtime
createRuntime(spec, {
  handlers: {
    purchaseBeforeCreate: ({ input }) => {
      if ((input.quantity as number) <= 0) throw new Error('quantity must be > 0')  // throwing cancels the op
      input.processedAt = new Date().toISOString()  // mutate input in place to change what is persisted
    },
    purchaseAfterCreate: ({ input }) => { /* fire-and-forget side effect */ },
  },
})
```

- **`beforeCreate` / `beforeUpdate` / `beforeDelete`** — may throw to cancel; mutate `input` **in place** to alter what's persisted.
- **`afterCreate` / `afterUpdate` / `afterDelete`** — fire-and-forget; failures are swallowed.

### Custom endpoints

Add fully custom routes onto a resource's router:

```ts
// spec
customEndpoints: [{ method: 'GET', path: '/bestsellers', handler: 'productBestsellers' }]

// runtime — handler receives store + Hono context
handlers: {
  productBestsellers: ({ store, ctx }) => {
    const products = Array.from(store.get('product')?.values() ?? [])
    return ctx.json({ data: products.slice(0, 3) })
  },
}
```

Custom endpoints can require auth/roles via `auth: true` / `roles: [...]`.

---

## Security

Security middleware is enabled by default and configured from the spec:

```ts
{
  cors: {
    origins: ['https://app.example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    headers: ['Content-Type', 'Authorization'],
    credentials: true,
  },
  security: {
    hsts: true,
    noSniff: true,
    frameguard: 'DENY',
    contentSecurityPolicy: true,
    xssProtection: true,
    referrerPolicy: 'no-referrer',
  },
  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    byUser: true,
    message: 'Rate limit exceeded',
  },
}
```

| Layer | Default | Toggle |
|---|---|---|
| Helmet security headers | on | `createRuntime(spec, { enableHelmet: false })` |
| CORS | on | `{ enableCors: false }` |
| Rate limiting | on when `spec.rateLimit` is set | `{ rateLimitStore }` for Redis |
| JSON injection sanitisation | on | `{ enableSanitize: false }` |

For multi-instance deployments, pass a shared rate-limit store:

```ts
import { RedisRateLimitStore } from '@ludagg/zeroapi-runtime'
createRuntime(spec, { rateLimitStore: new RedisRateLimitStore(redisClient) })
```

---

## Observability

Always-on, zero-config observability:

- **Request ID** — every request gets a correlation ID (response header + log context).
- **`GET /health`** — `{ status, name, version, uptime, configCheck }`. `configCheck` reports the *names* of any missing required env vars (never values).
- **`GET /ready`** — a **real readiness probe**: in Prisma mode it runs a light `SELECT 1` and returns **`503`** when the database is unreachable, so an orchestrator stops routing traffic to a broken instance (memory mode → `200`).
- **Graceful shutdown** — `await runtime.shutdown()` stops the webhook worker (in-flight deliveries finish, none are cut) and disconnects Prisma; idempotent, no-op in memory. Pass `handleSignals: true` to bind `SIGTERM`/`SIGINT` automatically.
- **Structured logger** — `createLogger({ level })`; set the floor with `createRuntime(spec, { logLevel: 'debug' })`.

---

## Environment variables

Declare the env vars your API needs and ZeroAPI manages them for you:

```ts
env: [
  { name: 'JWT_SECRET',   required: true, generate: true },          // auto-generated if missing
  { name: 'DATABASE_URL', required: true, example: 'postgres://…' },
  { name: 'S3_BUCKET',    required: false, description: 'Upload bucket' },
]
```

- **`getRequiredEnvVars(spec)`** — aggregate every required var (declared + implied by features).
- **`generateEnvExample(spec)`** — produce a ready-to-commit `.env.example`.
- **At boot** — `validateAndGenerateEnv` runs automatically: it generates values for `generate: true` vars, warns in dev, and **fails fast in production** on missing required vars.
- **`createRuntime(spec, { validateEnv: true })`** — also enforce the legacy `spec.requiredEnv` list at startup.

---

## Persistence (in-memory vs Prisma)

By default the runtime uses an **in-memory `Map` store** — perfect for prototyping, tests, and CI, but all data is lost on restart.

For production, the runtime auto-detects a Prisma client (when `DATABASE_URL` is set and `@prisma/client` is installed) and uses Prisma-backed stores for API keys, users, refresh tokens, and OAuth accounts. In `NODE_ENV=production` it **refuses to silently fall back to memory** for auth — you must either provide Prisma or pass explicit stores.

```ts
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

createRuntime(spec, {
  prisma,        // backs the API-key store
  prismaJwt: prisma,  // backs user + refresh-token stores
})
```

The generated `prismaSchema` (see below) is the source of truth for your database.

### Applying the schema (opt-in, never destructive)

`createRuntime` **never touches the database on its own** — applying the schema is always an explicit step. Helpers reduce the friction safely:

```ts
import { writePrismaSchema, pushPrismaSchema, deployPrismaMigrations } from '@ludagg/zeroapi-runtime'

// write the generated schema to disk (pure I/O — the basis for any prisma command)
writePrismaSchema(spec, 'prisma/schema.prisma')

// DEV / prototype — sync the database to the schema (creates tables)
await pushPrismaSchema({ spec })
//   ↳ skipped without DATABASE_URL · refused in NODE_ENV=production unless allowProduction:true
//   ↳ never passes --accept-data-loss unless acceptDataLoss:true (Prisma refuses destructive changes)

// PRODUCTION — apply committed, versioned migrations (non-destructive by construction)
await deployPrismaMigrations({ schemaPath: 'prisma/schema.prisma' })
```

Use `pushPrismaSchema` for dev/prototyping; for production, commit migrations (`prisma migrate dev` against the generated schema) and ship them with `deployPrismaMigrations` / `prisma migrate deploy`.

---

## Generated artifacts

`createRuntime` returns more than just the app — it returns everything you need to ship:

```ts
const { app, prismaSchema, zodSchemas, openApiSpec, testSuite, spec, ready } = createRuntime(rawSpec)
```

You can also call the generators directly:

```ts
import {
  generatePrismaSchema,   // → Prisma schema string
  generateZodSchemas,     // → Zod validators per resource
  generateOpenAPISpec,    // → OpenAPI 3.0.3 document
  generateTests,          // → a Vitest test suite for the API
  generateSdk,            // → a typed TypeScript client
  generatePostmanCollection, // → Postman v2.1 collection
  generateReadme,         // → API reference markdown
  generateEnvExample,     // → .env.example
  // deploy config generators
  generateRailwayConfig, generateRenderConfig, generateVercelConfig, generateFlyConfig,
} from '@ludagg/zeroapi-runtime'
```

---

## `createRuntime(spec, options?)` reference

```ts
const result = createRuntime(spec, {
  // ── Middleware toggles ──────────────────────────────────────────────
  enableLogging:  true,    // Hono request logger
  enableCors:     true,    // CORS (uses spec.cors)
  enableHelmet:   true,    // security headers (uses spec.security)
  enableSanitize: true,    // JSON injection sanitiser
  enableDocs:     true,    // /docs + /openapi.json

  // ── Hooks & custom endpoints ────────────────────────────────────────
  handlers: { /* handlerId → fn */ },

  // ── Storage / uploads ───────────────────────────────────────────────
  uploadDir: './uploads',
  storageProvider,         // override auto-resolved provider

  // ── Observability & lifecycle ───────────────────────────────────────
  logLevel: 'info',
  handleSignals: false,    // bind SIGTERM/SIGINT → shutdown() (opt-in)

  // ── Querying ────────────────────────────────────────────────────────
  maxIncludeDepth: 4,      // cap nested ?include= depth (400 beyond it)

  // ── Rate limiting ───────────────────────────────────────────────────
  rateLimitStore,          // e.g. RedisRateLimitStore for multi-instance
  authRateLimit: { windowMs: 15 * 60_000, max: 20 },  // per-IP on /auth/login + /auth/register (or false)

  // ── Env validation ──────────────────────────────────────────────────
  validateEnv: false,      // enforce spec.requiredEnv at boot

  // ── Persistence (Prisma) ────────────────────────────────────────────
  prisma,                  // backs API-key + resource + webhook stores
  prismaJwt,               // backs user + refresh-token stores
  apiKeyStore, userStore, refreshTokenStore, revocationStore,   // explicit overrides
  oauthAccountStore, oauthStateStore,

  // ── Webhooks ────────────────────────────────────────────────────────
  webhookStore, webhookWorkerOptions, webhookWorkerAutostart,
  webhookInboundSources, webhookInboundOptions,
  webhookSecretEncryptionKey,   // AES-256-GCM at rest (or WEBHOOK_SECRET_ENCRYPTION_KEY)
})
```

**Returns** (`RuntimeResult`):

| Field | Type | Description |
|---|---|---|
| `app` | `Hono` | the wired application |
| `prismaSchema` | `string` | generated Prisma schema |
| `zodSchemas` | `Record<string, ResourceSchemas>` | per-resource validators |
| `openApiSpec` | `OpenAPISpec` | OpenAPI 3.0.3 document |
| `testSuite` | `string` | generated Vitest suite |
| `spec` | `ZeroAPISpec` | the parsed spec |
| `ready` | `Promise<void>` | resolves once async boot (e.g. API-key bootstrap) completes |
| `shutdown` | `() => Promise<void>` | graceful shutdown — stop the webhook worker + disconnect Prisma (idempotent) |
| `webhooks?` | `{ store, worker }` | present when webhooks are enabled |
| `deleteSystemResource?` | `(name, id) => Promise<CascadeResult>` | cascade-aware delete for system resources (e.g. `User`) |

> When using an external (Prisma) store, `await result.ready` before serving traffic so the bootstrap key is persisted first.

---

## Built-in endpoints

Beyond the per-resource CRUD routes, the runtime mounts:

| Path | Enabled by | Purpose |
|---|---|---|
| `GET /health` | always | liveness + uptime + config check |
| `GET /ready` | always | readiness probe |
| `GET /docs` | `enableDocs` | Scalar API reference UI |
| `GET /openapi.json` | `enableDocs` | OpenAPI 3.0.3 document |
| `GET /uploads/:key` | local file upload | serve uploaded files |
| `/auth/*` | JWT / auth flows | register, login, refresh, logout, me, … |
| `/auth/oauth/*` | OAuth | provider redirect + callback |
| `/admin/api-keys*` | API-key auth | key management |
| `/admin/webhooks*` | outbound webhooks | endpoint management |
| `/webhooks/inbound/:source` | inbound webhooks | receive signed events |

---

## Examples

Runnable examples live in [`examples/`](./examples):

| Example | Highlights |
|---|---|
| [`basic-api`](./examples/basic-api) | Two resources, no auth — the minimal setup |
| [`auth-api`](./examples/auth-api) | JWT auth, CORS, rate limiting, security headers |
| [`ecommerce-api`](./examples/ecommerce-api) | Full feature set: RBAC, relations, transactions, file upload, hooks, custom endpoints, auth flows |

Run any example with:

```bash
npx tsx examples/ecommerce-api/index.ts
```

---

## Known limitations

These are current design boundaries, not bugs.

1. **Many-to-many filtering is membership-only.** In Prisma mode you can filter by a related id — `?tag=<tagId>` (translated to a `some` join clause) — but operator-style filters (`?tag[contains]=…`) on join-table data aren't resolved. *Workaround:* `?include=Tag` and filter client-side, or query the join resource directly.

2. **Cursor pagination with non-unique sort keys.** If several rows share a sort-key value and that group straddles a page boundary, ordering among equals isn't guaranteed identical across requests. *Fix:* add `id` as a secondary sort (`?sort=price:asc,id:asc`) for a stable total order.

3. **Nested creation: depth 1, manyToMany only.** A `POST` body may include a nested array of **join records** referencing already-existing related rows. Recursive creation of new related resources is not supported. If a nested reference is invalid, the whole request rolls back (`409`).

4. **In-memory store by default.** Data is lost on restart unless you wire Prisma-backed stores / a real database (see [Persistence](#persistence-in-memory-vs-prisma)). The generated `prismaSchema` is production-ready.

5. **Local upload provider writes to disk.** On ephemeral containers, files are lost on restart — use S3/R2 in production.

6. **Hook mutations must be in-place.** Mutate the `input` object directly; reassigning the parameter has no effect.

7. **After-hooks are fire-and-forget.** Failures are silently discarded — pair with a job queue if you need guaranteed delivery.

8. **Default rate limiter is single-instance.** Use `RedisRateLimitStore` for multi-instance deployments.

---

## Proven on real PostgreSQL

The Prisma-mode features aren't tested against a mock — they're verified against a **real PostgreSQL database**. The scripts in [`realdb/`](./realdb) spin up the generated schema and assert real behaviour: SQL query pushdown (logged `WHERE`/`ORDER BY`/`LIMIT` + `EXPLAIN`), relation cascades inside one `$transaction`, webhook persistence + no-double-delivery under concurrent workers, encrypted-at-rest secrets (`enc:v1:…` in the DB), token revocation, `/ready` flipping `200 → 503 → 200` as the cluster stops/restarts, and migration helpers creating tables (with their safety guardrails). See [`REAL_DB_TEST.md`](./REAL_DB_TEST.md) for the methodology.

---

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run test          # vitest (watch)
npm run test:run      # vitest run (CI)
npm run test:coverage # coverage report
npm run build         # tsup → dist/ (CJS + ESM + .d.ts)
```

**1075 tests across 70 files** cover the parser, generators, query engine, relations, transactions, auth (JWT/API-key/OAuth/flows), RBAC, security, storage, webhooks, observability, env management, and docs.

The project is written in TypeScript, bundled with [tsup](https://tsup.egoist.dev), and tested with [Vitest](https://vitest.dev).

---

## Publishing

Publishing to npm is automated: any push to `main` triggers the GitHub Actions workflow in [`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which runs the tests, builds, and publishes. See [`PUBLISHING.md`](./PUBLISHING.md) for setting up the `NPM_TOKEN` secret.

---

## License

MIT © Ludovic Aggaï NGABANG
