# Changelog

All notable changes to `@ludagg/zeroapi-runtime` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
