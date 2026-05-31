import type { ZeroAPISpec, ResourceDefinition, FieldDefinition, FieldType } from '../types/spec.js'
import {
  planResourceRelations, relationFieldBase, relationLinkName, padFieldName,
  type RelationRenderPlan,
} from '../relations/index.js'
import { renderWebhookModels } from '../webhooks/schema.js'

const PRISMA_TYPE_MAP: Record<FieldType, string> = {
  string: 'String', text: 'String', email: 'String', url: 'String', uuid: 'String',
  number: 'Float', integer: 'Int', decimal: 'Decimal', boolean: 'Boolean',
  date: 'DateTime', datetime: 'DateTime',
  file: 'String',        // stored as URL
  'file[]': 'String',    // stored as URL list (schema-level rendering handled in Phase 1+)
  json: 'Json',
  enum: 'String',        // enum rendering handled in Phase 1+
}

/**
 * Maps a spec default value to a Prisma generator function when the value names
 * a known function for the given field type. Returns the call expression
 * (e.g. `now()`) when applicable, or `null` to fall back to a literal.
 *
 * Prisma's `@default(...)` distinguishes FUNCTIONS (`now()`, `uuid()`, …) from
 * literal values (`"pending"`). Emitting `@default("now")` for a DateTime field
 * makes `prisma generate` fail with "'now' is not a valid rfc3339 datetime
 * string", so date/datetime "now" defaults must render as the bare `now()`
 * function — never a quoted string.
 */
function prismaDefaultFunction(field: FieldDefinition, value: string): string | null {
  // Accept both the bare name ("now") and the call form ("now()").
  const fn = value.replace(/\(\)$/, '')
  switch (field.type) {
    case 'date':
    case 'datetime':
      return fn === 'now' ? 'now()' : null
    case 'uuid':
    case 'string':
    case 'text':
      if (fn === 'uuid') return 'uuid()'
      if (fn === 'cuid') return 'cuid()'
      return null
    case 'integer':
    case 'number':
      return fn === 'autoincrement' ? 'autoincrement()' : null
    default:
      return null
  }
}

function renderField(name: string, field: FieldDefinition): string {
  const prismaType = PRISMA_TYPE_MAP[field.type]
  const optional   = field.required ? '' : '?'
  const unique     = field.unique ? ' @unique' : ''

  let defaultClause = ''
  if (field.default !== undefined && field.default !== null) {
    if (typeof field.default === 'string') {
      // A string default is either a Prisma function (rendered unquoted, e.g.
      // now() / uuid() / cuid()) or a genuine literal (rendered quoted).
      const fn = prismaDefaultFunction(field, field.default)
      defaultClause = fn ? ` @default(${fn})` : ` @default("${field.default}")`
    } else {
      defaultClause = ` @default(${String(field.default)})`
    }
  }

  // Pad to column 14 for short names; for names ≥ 13 chars guarantee at least
  // 2 spaces before the type so we never produce e.g. "priceAtPurchaseDecimal".
  const paddedName = name.padEnd(Math.max(14, name.length + 2))
  return `  ${paddedName}${prismaType}${optional}${unique}${defaultClause}`
}

const RESERVED_FIELDS = new Set(['id', 'createdAt', 'updatedAt'])

function resourceHasOwnOnly(spec: ZeroAPISpec, resourceName: string): boolean {
  return (spec.permissions ?? []).some(
    (p) => p.resource === resourceName && p.rules.some((r) => r.ownOnly),
  )
}

function renderModel(
  resource: ResourceDefinition,
  ownedByUser: boolean,
  plan: RelationRenderPlan,
): string {
  const modelName = resource.name.charAt(0).toUpperCase() + resource.name.slice(1)

  // FK fields owned by relations (incl. m2m-join FKs) — never re-declared from
  // spec fields. The plan is the authoritative source of which columns a model
  // owns; it already collapses redundant declarations.
  const relationFkFields = new Set<string>(plan.fkColumnsByModel.get(modelName) ?? [])
  // Explicit relation to the system User (manyToOne/oneToOne) takes precedence
  // over the implicit ownOnly userId injection — the explicit relation already
  // emits `userId String` + `user User @relation(...)`.
  const hasExplicitUserRelation = (resource.relations ?? []).some(
    (rel) =>
      rel.resource === 'User' &&
      (rel.type === 'manyToOne' || rel.type === 'oneToOne'),
  )
  // Skip a spec-declared "userId" field when ownership injection owns the column,
  // so we don't emit it twice.
  if (ownedByUser) relationFkFields.add('userId')

  const baseFields = [
    `  id            String   @id @default(cuid())`,
    `  createdAt     DateTime @default(now())`,
    `  updatedAt     DateTime @updatedAt`,
    ...Object.entries(resource.fields)
      .filter(([name]) => !RESERVED_FIELDS.has(name) && !relationFkFields.has(name))
      .map(([name, field]) => renderField(name, field)),
  ]

  if (ownedByUser && !hasExplicitUserRelation) {
    baseFields.push(`  userId        String`)
    baseFields.push(`  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)`)
  }

  const relationLines = plan.linesByModel.get(modelName) ?? []
  const extraLines = plan.extrasByModel.get(modelName) ?? []

  return `model ${modelName} {\n${[...baseFields, ...relationLines, ...extraLines].join('\n')}\n}`
}

/**
 * Generates a complete Prisma schema string from a ZeroAPI spec.
 * Includes all models, relation fields, and join models for manyToMany relations.
 */
export function generatePrismaSchema(spec: ZeroAPISpec): string {
  const header = `// Generated by @ludagg/zeroapi-runtime — do not edit manually
// Spec: ${spec.name} v${spec.version}

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}`

  // Shallow-clone resources (relations array copied) so planning is side-effect free.
  const resources = spec.resources.map((r) => ({ ...r, relations: r.relations ? [...r.relations] : undefined }))

  const ownedResources = resources.filter((r) => resourceHasOwnOnly(spec, r.name))

  // Reduce every relation to a de-duplicated set of owning FK links, detect
  // ambiguity systematically (any model pair connected more than once), and
  // render relation fields + join models from that single source of truth.
  const plan = planResourceRelations(resources)
  const joinModels = plan.createdJoinModels

  const models = resources
    .map((r) => renderModel(r, resourceHasOwnOnly(spec, r.name), plan))
    .join('\n\n')

  // Phase 1.1: API-key storage model — emitted whenever apikey auth is active
  const apiKeyAuthEnabled =
    spec.auth?.strategy === 'apikey' || spec.auth?.apikey?.enabled === true

  // Phase 1.2: JWT user system — emit User + RefreshToken when opted in.
  // Phase 1.3: extend User with back-relations for each ownOnly-owned resource.
  // Phase 1.4: extend User with `oauthAccounts` back-relation when OAuth is configured.
  // Phase 2.2: extend User with back-relations for any user-defined resource
  // that declares an explicit manyToOne / oneToOne to "User".
  const jwtUserSystemEnabled = spec.auth?.jwt?.enabled === true
  const oauthEnabled = (spec.auth?.oauth?.providers?.length ?? 0) > 0

  // Every system resource a user-defined model can point at needs the matching
  // back-relation array field rendered on it, or Prisma raises P1012 ("missing
  // opposite relation field"). User additionally absorbs the ownOnly-owned
  // resources injected via the RBAC `userId` column.
  const userBackRelations = jwtUserSystemEnabled
    ? collectBackRelations(resources, 'User', ownedResources.map((r) => r.name))
    : []
  const refreshTokenBackRelations = jwtUserSystemEnabled
    ? collectBackRelations(resources, 'RefreshToken', [])
    : []
  const apiKeyBackRelations = apiKeyAuthEnabled
    ? collectBackRelations(resources, 'ApiKey', [])
    : []
  const oauthBackRelations = oauthEnabled
    ? collectBackRelations(resources, 'OAuthAccount', [])
    : []

  const apiKeyModel = apiKeyAuthEnabled ? renderApiKeyModel(apiKeyBackRelations) : null
  const jwtUserModels = jwtUserSystemEnabled
    ? renderJwtUserModels(userBackRelations, oauthEnabled, refreshTokenBackRelations)
    : []
  const oauthModel = oauthEnabled ? renderOAuthAccountModel(oauthBackRelations) : null

  // Phase 3.3: webhook models — emitted only when the feature is enabled
  // (either outbound or inbound events declared).
  const webhooksFeature = spec.features?.webhooks
  const webhooksEnabled =
    !!webhooksFeature &&
    ((webhooksFeature.outbound?.length ?? 0) > 0 || (webhooksFeature.inbound?.length ?? 0) > 0)
  const webhookModels = webhooksEnabled ? renderWebhookModels() : []

  const parts = [header, models, ...joinModels, apiKeyModel, ...jwtUserModels, oauthModel, ...webhookModels].filter(Boolean)
  return parts.join('\n\n') + '\n'
}

/** Renders the back-relation array lines (`<name> Model[] [@relation("…")]`)
 *  to splice onto a system model. */
function renderBackRelationLines(backs: UserBackRelation[]): string[] {
  return backs.map((b) => {
    const relClause = b.relationName ? ` @relation("${b.relationName}")` : ''
    return `  ${padFieldName(b.field)}${b.model}[]${relClause}`
  })
}

/** Appends extra relation lines just before a model's closing brace. */
function withExtraLines(model: string, extra: string[]): string {
  if (extra.length === 0) return model
  return model.replace(/\n}$/, '\n' + extra.join('\n') + '\n}')
}

function renderApiKeyModel(backRelations: UserBackRelation[] = []): string {
  const model = `model ApiKey {
  id         String    @id @default(uuid())
  keyHash    String    @unique
  keyPrefix  String
  name       String?
  role       String    @default("admin")
  revoked    Boolean   @default(false)
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())
}`
  return withExtraLines(model, renderBackRelationLines(backRelations))
}

/** Back-reference line to emit on the User model. `field` is the plural
 *  lowercased model name (e.g. "orders"), `model` is the target model. */
interface UserBackRelation {
  field: string
  model: string
  /** Explicit @relation name — set only when the owning model has several
   *  relations to User and the back-relations must be disambiguated. */
  relationName?: string
}

/**
 * Collects the back-relations to emit on a system model (`targetName`):
 *   · `<name>s` (lowercased plural) for a resource that declares a single
 *     explicit manyToOne / oneToOne to the target in its `relations[]`
 *   · one named back-relation PER relation when a resource declares SEVERAL
 *     relations to the target (e.g. `buyerId` + `sellerId` → User): without
 *     distinct field names and matching `@relation("…")` names Prisma raises
 *     P1012.
 *   · `owned<Name>s` for resources owned via the ownOnly RBAC `userId`
 *     injection (only meaningful for the User target).
 *
 * Explicit relations and ownOnly injection are de-duplicated by source model
 * so a resource that is both ownOnly AND explicitly related contributes the
 * explicit relation only.
 */
function collectBackRelations(
  resources: ResourceDefinition[],
  targetName: string,
  ownedResourceNames: string[],
): UserBackRelation[] {
  const out: UserBackRelation[] = []
  const explicitModels = new Set<string>()

  for (const resource of resources) {
    const rels = (resource.relations ?? []).filter(
      (rel) =>
        rel.resource === targetName &&
        (rel.type === 'manyToOne' || rel.type === 'oneToOne'),
    )
    if (rels.length === 0) continue
    const modelName = resource.name.charAt(0).toUpperCase() + resource.name.slice(1)
    explicitModels.add(modelName)

    if (rels.length === 1) {
      out.push({ field: `${resource.name.toLowerCase()}s`, model: modelName })
    } else {
      // Multiple relations to the same target → emit one named back-relation
      // each so the FK side (rendered with the same name) pairs unambiguously.
      for (const rel of rels) {
        out.push({
          field: `${relationFieldBase(rel)}${modelName}s`,
          model: modelName,
          relationName: relationLinkName(modelName, rel),
        })
      }
    }
  }

  for (const name of ownedResourceNames) {
    const modelName = name.charAt(0).toUpperCase() + name.slice(1)
    if (explicitModels.has(modelName)) continue
    explicitModels.add(modelName)
    out.push({ field: `owned${modelName}s`, model: modelName })
  }

  return out
}

function renderJwtUserModels(
  backRelations: UserBackRelation[],
  includeOAuth: boolean,
  refreshTokenBackRelations: UserBackRelation[] = [],
): string[] {
  const extraLines: string[] = []
  if (includeOAuth) {
    extraLines.push(`  oauthAccounts OAuthAccount[]`)
  }
  extraLines.push(...renderBackRelationLines(backRelations))

  const userModel = `model User {
  id            String    @id @default(uuid())
  email         String    @unique
  passwordHash  String
  salt          String
  role          String    @default("user")
  emailVerified Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  refreshTokens RefreshToken[]${extraLines.length > 0 ? '\n' + extraLines.join('\n') : ''}
}`

  const refreshTokenModel = withExtraLines(
    `model RefreshToken {
  id        String   @id @default(uuid())
  tokenHash String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  revoked   Boolean  @default(false)
  createdAt DateTime @default(now())
}`,
    renderBackRelationLines(refreshTokenBackRelations),
  )

  // P1: access-token revocation (jti blacklist + per-user cutoff). One row per
  // revocation; pruned once `expiresAt` passes.
  const revokedTokenModel = `model RevokedToken {
  id        String    @id @default(uuid())
  jti       String?   @unique
  userId    String?
  notBefore DateTime?
  expiresAt DateTime
  createdAt DateTime  @default(now())

  @@index([userId])
}`

  return [userModel, refreshTokenModel, revokedTokenModel]
}

function renderOAuthAccountModel(backRelations: UserBackRelation[] = []): string {
  const model = `model OAuthAccount {
  id         String   @id @default(uuid())
  provider   String
  providerId String
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt  DateTime @default(now())
  @@unique([provider, providerId])
}`
  return withExtraLines(model, renderBackRelationLines(backRelations))
}
