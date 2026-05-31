# Changelog

All notable changes to `@ludagg/zeroapi-runtime` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.21.1] - 2026-05-31

Patch: audit quick wins.

### Fixed

- **Soft-delete now actually works.** `softDelete` was declared in the spec but
  unimplemented. For a `softDelete` resource the generated schema now emits a
  `deletedAt DateTime?` tombstone column, `DELETE` marks `deletedAt` instead of
  removing the row, and `list` / `read` (plus `update` / `delete`) hide
  tombstoned rows by default — pushed to SQL (`WHERE deletedAt IS NULL`) in
  Prisma mode and filtered in memory mode. The new `?includeDeleted=true` query
  param opts back in. Proven on real PostgreSQL **and** memory: a soft-deleted
  row disappears from `list`/`read`, `404`s on read/update, reappears with
  `?includeDeleted=true`, and physically survives in the database with
  `deletedAt` set.
- **Transaction `failedOperation` reports the real operation.** The in-memory
  transaction executor used to stringify an object to `"[object Object]"` on
  failure; it now tracks the operation currently running and reports it
  (e.g. `"decrement Product"`), matching the Prisma executor.

### CI

- **Pull requests are now validated.** A new `ci.yml` workflow runs `typecheck`
  + the full test suite on every PR (and non-`main` push) without publishing, so
  changes are checked before merge. The publish workflow stays dedicated to
  `main`.

## [0.21.0] - 2026-05-31

Production-scale **Prisma mode** + **auth security** release. Three runtime gaps
from the audit are closed and proven against real PostgreSQL.

### Added

- **SQL query pushdown (Prisma mode).** Filtering (`?status=`, `?price[gte]=`),
  full-text search (`?q=` → `ILIKE`), sorting (`?sort=`) and pagination
  (`?page=&limit=` / `?cursor=`) are now translated into a single SQL query
  (`WHERE` / `ORDER BY` / `LIMIT` / `OFFSET`) plus a real SQL `COUNT` — the
  database no longer ships the whole table to Node. Multi-tenant scope, M2M
  filters and the nested-route parent FK are folded into the same `WHERE` and
  stay authoritative. Filter values are re-coerced to the declared field type so
  a numeric-looking value on a `String` column no longer trips Prisma. Memory
  mode is unchanged. `ResourceStore` gains `count()` and richer `ReadOptions`
  (`orderBy` / `skip` / `take` / `cursor`).
- **Complete relations in Prisma mode.** Nested routes
  (`/parent/:id/children`), nested many-to-many creation, and the
  system-resource cascade now operate against the database instead of the
  in-memory map (previously silently broken under Prisma): the parent is checked
  with `findUnique`, join rows are written to the DB (composite-PK join, no `id`
  column), and `onDelete` (`Cascade` / `SetNull` / `Restrict`) is applied in the
  DB. The cascade **and** the system-row delete run in **one
  `prisma.$transaction`** — a failed delete rolls every child mutation back.
- **Access-token revocation.** New `TokenRevocationStore` (memory + Prisma, one
  read per request) backs a `jti` blacklist plus a per-user cutoff. `logout`
  now revokes the presented access token by `jti`; deleting a user revokes all
  of their live sessions. Backed by a generated `RevokedToken` model and
  auto-wired alongside the other JWT Prisma stores.
- **Per-IP auth rate limiting.** `/auth/login` and `/auth/register` are
  throttled per IP (default 20 / 15 min) as defence-in-depth over the
  per-account lockout. Configurable via `RuntimeOptions.authRateLimit`
  (`{ windowMs, max }`, or `false` to disable). New
  `createAuthRateLimitMiddleware` export.

### Changed

- ⚠️ **BREAKING — JWT/bearer auth now requires a configured secret.** The auth
  middleware previously **accepted any structurally-valid (3-segment) token when
  no secret was configured**, including unsigned `alg:none` tokens. It now
  **fails closed**: with no secret to verify against, the token is refused
  (`401`). The JWT user system (`auth.jwt.enabled`) is unaffected — it always
  resolves a secret. *Migration:* set a secret for any legacy
  `auth: { strategy: 'jwt' | 'bearer' }` config (`auth.secret` or `JWT_SECRET`).

### Verified

- Proven against **real PostgreSQL**: SQL pushdown (logged `WHERE`/`ORDER BY`/
  `LIMIT`/`COUNT`, 1000 rows → 10 fetched, `EXPLAIN` shows a `Limit` node);
  nested routes + M2M persistence + atomic cascade rollback; token rejected
  after logout and after user deletion; no-secret refusal; `/auth/login`
  brute-force throttled. **1066 unit tests** green; `tsc` clean.

## [0.20.1] - 2026-05-30

Patch: **Prisma `@default(...)` function rendering**.

### Fixed

- **`@default(now())` / `uuid()` / `cuid()` / `autoincrement()` are now emitted
  as Prisma generator functions** (unquoted call form) instead of invalid
  string literals. A `date` / `datetime` field with a `"now"` default used to
  render `@default("now")`, which Prisma rejects (*"'now' is not a valid
  rfc3339 datetime string"*) — breaking `npx prisma generate` at deploy. The
  default emitter now maps known generator functions per field type
  (`now` for date/datetime, `uuid`/`cuid` for string-like, `autoincrement` for
  integer) to their unquoted form, while genuine literals (e.g. an `enum`
  default `"pending"`) stay quoted.

### Notes

- Regression coverage added, including a `prisma validate` check over a spec
  with `enrollmentDate` / `issueDate` / `date` defaults. 1066 tests across 69
  files; `tsc --noEmit` clean.

## [0.20.0] - 2026-05-30

Declarative business logic, step 3: **relation aggregates**.

### Added

- **Declarative aggregates (`aggregates`)** over a `oneToMany` relation —
  `count` / `sum` / `avg` / `min` / `max`, a closed operator set (no custom
  expressions). Exposed **opt-in** via `?include=<name>`, so plain reads stay
  lean. `field` is required for everything except `count`, and must be numeric
  for `sum` / `avg`.
- **Batched execution (no N+1)**: for a list of N rows, each relation is
  resolved with a single Prisma `groupBy` over `fk IN (pageIds)` — the query
  count grows with the number of distinct relations, never with N. Memory mode
  folds over the child collection. Both produce identical results.

### Notes

- No schema change (aggregates are computed at read) → `prisma validate`
  unaffected. Parser validates: relation must be an existing `oneToMany`; `field`
  required/forbidden per op; `sum`/`avg` fields must be numeric.
- Validated on **real PostgreSQL 16** (`realdb/agg-*`): values for
  count/sum/avg/min/max, and the anti-N+1 guarantee proven by counting actual
  `GROUP BY` queries (22 rows → exactly 2). 1062 tests across 69 files; `tsc
  --noEmit` clean. Many-to-many aggregates deferred to a follow-up.

## [0.19.0] - 2026-05-30

Declarative business logic, step 2: **state machines / workflows**.

### Added

- **Declarative state machines (`stateMachine`)** over an existing enum field:
  declare the allowed `from → to` transitions and which roles may perform each.
  - **create** forces the field to `initial` (a client can't create a row
    directly in a later state);
  - **update** changing the field validates `from` (the persisted value) → `to`
    (the requested value): an unlisted transition returns **409**, a listed one
    the caller's role isn't allowed to perform returns **403**;
  - **update** not touching the field is unconstrained.
  Works in both Memory and Prisma modes (the current state is read before
  validating). Reuses the existing enum + RBAC roles — no new role system.
- Parser validation: `field` must be an existing enum; `initial` and every
  `from`/`to` must be a value of that enum.

### Notes

- Conditional guards and side-effects are deliberately out of scope — they stay
  in `hooks` / `transactions` / `webhooks`.
- Validated on **real PostgreSQL 16** (`realdb/sm-*`): create-forcing, 200/409/403
  transitions, and unconstrained non-state updates. 1047 tests across 68 files;
  `tsc --noEmit` and `prisma validate` clean.

## [0.18.0] - 2026-05-30

First step of declarative business logic beyond CRUD: **native multi-tenancy**.

### Added

- **Declarative RBAC scope (`scope: { column, claim }`)** — a permission rule can
  now isolate rows by any column matched against a JWT claim, giving native
  **multi-tenant** isolation (per organisation / workspace / tenant). Works in
  both Memory and Prisma modes; in Prisma mode the filter is pushed to the
  database `where`, so other tenants' rows never leave it.
  - **read / list** — returns only in-scope rows.
  - **create** — forces the scope column to the claim value: a member of org A
    cannot write into org B, even if the request body says so.
  - **update / delete** — out-of-scope rows return **404** (existence is never
    leaked); a token missing the claim is **403**.
- The auth middleware now exposes the full verified JWT payload as `claims`, so
  scope rules can read arbitrary claims (e.g. `organizationId`).

### Changed

- **`ownOnly` is now a special case of `scope`** (`{ column: 'userId', claim:
  'sub' }`) — fully backwards-compatible, no spec changes required.

### Verified

- Validated on **real PostgreSQL 16** with a real `@prisma/client`
  (`realdb/scope-*`): tenant isolation, create-forcing, same-org sharing, and
  cross-tenant 404. 1026 tests across 67 files (incl. the multi-tenant suite run
  in both modes); `tsc --noEmit` and `prisma validate` clean.

## [0.17.2] - 2026-05-30

Finition of the Prisma-mode subsystems: closes the three minor gaps left by
0.17.1. **Memory mode is unchanged** — every change is gated behind Prisma mode.

### Fixed

- **ownOnly now applies to *included* relations (Prisma mode).** Native
  `?include=` bypassed the in-memory ownOnly filtering, so included rows of an
  ownOnly resource weren't scoped to the requester. `buildPrismaInclude` now
  injects a row-level `where: { userId }` on ownOnly to-many includes (a
  no-identity sentinel when unauthenticated, so nothing leaks).
- **M2M filtering extended to explicit association entities.** Filtering through
  a join *resource* (e.g. `OrderItem`) now derives the target FK from the join's
  real relation, so custom FK field names work — not just the synthetic
  `<target>Id` convention.
- **Self-M2M directions disambiguated.** A self many-to-many can name both
  directions via `as` / `reverseAs` (e.g. `following` / `followers`). Includes
  and filters resolve each direction to the correct join FK and far side
  (`?include=following`, `?followers=<id>`, …); the schema stays
  `prisma validate`-clean.

### Verified

- All three fixes validated against **real PostgreSQL 16** with a real
  `@prisma/client` (see `REAL_DB_TEST.md` + `realdb/`), in addition to the fake.
  Real-DB note: ownOnly resources carry a genuine `userId → User` FK, which the
  in-memory fake did not enforce.
- 1014 tests across 66 files; `tsc --noEmit` clean; `prisma validate` clean.

## [0.17.1] - 2026-05-30

Builds on the resource persistence introduced in 0.17.0 by wiring the
remaining data subsystems onto Prisma when a Prisma client is in use. **Memory
mode stays the default and is unchanged** — every Prisma path is gated behind
the resolved store, so existing in-memory behaviour does not regress.

### Added

- **Relations / includes — native Prisma resolution.** In Prisma mode the
  route's `?include=` is translated into a native Prisma `include` tree and
  resolved by the database in a single query. **Nested includes of any depth**
  are supported (e.g. `?include=comment.author` → Post + Comments + Authors in
  one call), closing the previous "1 level only" limitation. Memory mode keeps
  the in-memory `applyIncludes` (1 level).
- **Many-to-many — filtering.** In Prisma mode a relation filter such as
  `?hashtag=<id>` is pushed down to the database as
  `where: { <join>: { some: { <fk>: <id> } } }`, and combines correctly with
  scalar filters (which still apply in memory).
- **Transactions — real ACID.** In Prisma mode transactional operations run
  inside a single `prisma.$transaction(...)` (real rollback). The guarded
  `decrement` is concurrency-safe by construction — a conditional
  `updateMany({ where: { id, field: { gte: amount } }, data: { field: {
  decrement } } })` lets the database enforce the guard and the write atomically
  under a row lock (out of N concurrent requests, only the ones with enough
  stock commit; the rest roll back → 409). Memory mode keeps the Map-snapshot
  executor.

### Fixed

- **Self many-to-many schema is now valid.** A self relation (e.g. `User
  follows User` via a join table) used to emit an invalid join model —
  duplicated `xId` columns, duplicated relation fields and `@@id([xId, xId])`
  (Prisma P1012). It now emits two distinct FK columns and paired
  `@relation("…")` names on both the join model and the self model's
  back-arrays. Verified against the real `prisma validate`.
- **Pure association entities are accepted.** A first-class join resource that
  carries no scalar payload of its own (`fields: {}`, only relations) was
  rejected by the parser. Empty `fields` is now allowed when the resource
  declares relations; a resource with neither is still rejected.

### Notes

- 1003 tests across 63 files (was 885/58). The README test counts were
  harmonised to the real number.
- The Prisma-mode data paths are validated against a faithful fake Prisma
  client; schema fixes are validated against the real `prisma validate` CLI.

## [0.17.0]

### Added

- **Resource persistence via `PrismaResourceStore`.** Business resources
  (Product, Todo, …) can now be persisted to a database instead of living only
  in the in-memory `Map`. A `ResourceStore` abstraction (mirroring the auth
  `ApiKeyStore` pattern) is backed by `MemoryResourceStore` (default) or
  `PrismaResourceStore`; `resolveResourceStore()` picks Prisma when a `prisma`
  client is provided or auto-detected via `DATABASE_URL`, otherwise memory.
  Basic CRUD (list/get/create/update/delete) survives restarts in Prisma mode.
