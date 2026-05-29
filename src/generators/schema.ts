import type { ZeroAPISpec, ResourceDefinition, FieldDefinition, FieldType } from '../types/spec.js'
import { renderRelationFields, relationFieldBase, relationLinkName } from '../relations/index.js'
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

function renderField(name: string, field: FieldDefinition): string {
  const prismaType = PRISMA_TYPE_MAP[field.type]
  const optional   = field.required ? '' : '?'
  const unique     = field.unique ? ' @unique' : ''

  let defaultClause = ''
  if (field.default !== undefined && field.default !== null) {
    defaultClause =
      typeof field.default === 'string'
        ? ` @default("${field.default}")`
        : ` @default(${String(field.default)})`
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
  allResources: ResourceDefinition[],
  ownedByUser: boolean,
  extraLines: string[] = [],
): string {
  const modelName = resource.name.charAt(0).toUpperCase() + resource.name.slice(1)

  // FK fields owned by relations — must not be re-declared from spec fields
  const relationFkFields = new Set<string>()
  // Explicit relation to the system User (manyToOne/oneToOne) takes precedence
  // over the implicit ownOnly userId injection — the explicit relation already
  // emits `userId String` + `user User @relation(...)`.
  const hasExplicitUserRelation = (resource.relations ?? []).some(
    (rel) =>
      rel.resource === 'User' &&
      (rel.type === 'manyToOne' || rel.type === 'oneToOne'),
  )
  for (const rel of resource.relations ?? []) {
    if (rel.type === 'manyToOne' || rel.type === 'oneToOne') {
      relationFkFields.add(rel.field ?? `${rel.resource.toLowerCase()}Id`)
    }
  }
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

  const relationLines = renderRelationFields(resource, allResources)

  return `model ${modelName} {\n${[...baseFields, ...relationLines, ...extraLines].join('\n')}\n}`
}

/** PascalCase a single resource name (first letter upper). */
function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** PascalCase a snake/kebab join-table name (e.g. "order_items" → "OrderItems"). */
function snakeToPascal(str: string): string {
  return str
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

/**
 * Plans how each many-to-many `through` join table is materialised in the
 * schema, and the back-relation fields its endpoints need.
 *
 * The key fix here: a `through` table may name a resource the user already
 * declared in `resources[]` (e.g. an `OrderItem` carrying `quantity` /
 * `priceAtPurchase`). Emitting a fresh join model for it would produce a
 * second `model OrderItem { … }` and trip Prisma P1012. Instead we:
 *
 *   · ENRICH  — when the join name matches a user resource: append the FK
 *               columns, `@relation` fields and a composite `@@unique` to that
 *               existing model (only the parts not already declared).
 *   · CREATE  — otherwise: render a standalone join model from scratch.
 *
 * Either way the opposite endpoint gets its back-relation array field so the
 * emitted schema is a valid Prisma relation on both sides.
 *
 * Returns the freshly-created join models plus a map of extra lines to append
 * to existing models (keyed by PascalCase model name).
 */
function planJoinModels(resources: ResourceDefinition[]): {
  createdModels: string[]
  extraByModel: Map<string, string[]>
} {
  const userModelNames = new Set(resources.map((r) => pascal(r.name)))
  const createdModels: string[] = []
  const extraByModel = new Map<string, string[]>()
  const seenThrough = new Set<string>()

  const addExtra = (model: string, ...lines: string[]) => {
    const arr = extraByModel.get(model) ?? []
    arr.push(...lines)
    extraByModel.set(model, arr)
  }

  for (const resource of resources) {
    for (const rel of resource.relations ?? []) {
      if (rel.type !== 'manyToMany' || !rel.through) continue
      if (seenThrough.has(rel.through)) continue
      seenThrough.add(rel.through)

      const thisModel  = pascal(resource.name)
      const otherModel = pascal(rel.resource)
      const joinModel  = snakeToPascal(rel.through)
      const thisFk     = `${resource.name.toLowerCase()}Id`
      const otherFk    = `${rel.resource.toLowerCase()}Id`
      const onDelete   = rel.onDelete ? `, onDelete: ${rel.onDelete}` : ''

      // Back-relation array on the opposite endpoint. The declaring side
      // already gets one via renderRelationFields' manyToMany branch; skip if
      // the other side declares the inverse m2m itself (it gets one too) to
      // avoid an ambiguous duplicate relation field.
      const otherRes = resources.find((r) => r.name === rel.resource)
      const otherDeclaresInverse = (otherRes?.relations ?? []).some(
        (r) => r.type === 'manyToMany' && r.through === rel.through,
      )
      if (otherRes && otherRes.name !== resource.name && !otherDeclaresInverse) {
        const fieldName = `${resource.name.toLowerCase()}s`
        addExtra(otherModel, `  ${fieldName.padEnd(13)} ${joinModel}[]`)
      }

      if (userModelNames.has(joinModel)) {
        // ── ENRICH an existing user-defined resource ───────────────────────
        const joinRes = resources.find((r) => pascal(r.name) === joinModel)!
        const hasField = (n: string) => n in (joinRes.fields ?? {})
        const hasRelTo = (model: string) =>
          (joinRes.relations ?? []).some(
            (r) =>
              (r.type === 'manyToOne' || r.type === 'oneToOne') &&
              pascal(r.resource) === model,
          )

        const lines: string[] = []
        const addEndpoint = (fk: string, target: string, targetField: string) => {
          if (hasRelTo(target)) return // FK + @relation already emitted by renderRelationFields
          if (!hasField(fk)) lines.push(`  ${fk.padEnd(14)}String`)
          lines.push(`  ${targetField.padEnd(14)}${target}  @relation(fields: [${fk}], references: [id]${onDelete})`)
        }
        addEndpoint(thisFk, thisModel, resource.name.toLowerCase())
        addEndpoint(otherFk, otherModel, rel.resource.toLowerCase())
        lines.push(`  @@unique([${thisFk}, ${otherFk}])`)
        addExtra(joinModel, ...lines)
      } else {
        // ── CREATE a standalone join model ─────────────────────────────────
        const extraFields = Object.entries(rel.fields ?? {}).map(([name, field]) => {
          const prismaType = PRISMA_TYPE_MAP[field.type] ?? 'String'
          const opt = field.required ? '' : '?'
          return `  ${name.padEnd(14)}${prismaType}${opt}`
        })
        createdModels.push(
          `model ${joinModel} {\n` +
          `  ${thisFk.padEnd(14)}String\n` +
          `  ${otherFk.padEnd(14)}String\n` +
          (extraFields.length ? extraFields.join('\n') + '\n' : '') +
          `  ${resource.name.toLowerCase().padEnd(14)}${thisModel}  @relation(fields: [${thisFk}], references: [id]${onDelete})\n` +
          `  ${rel.resource.toLowerCase().padEnd(14)}${otherModel}  @relation(fields: [${otherFk}], references: [id]${onDelete})\n` +
          `\n  @@id([${thisFk}, ${otherFk}])\n}`,
        )
      }
    }
  }

  return { createdModels, extraByModel }
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

  // Plan many-to-many join tables first: a `through` table may reference a
  // user-declared resource, in which case we enrich that model in place
  // (extraByModel) instead of emitting a duplicate join model.
  const { createdModels: joinModels, extraByModel } = planJoinModels(resources)

  const models = resources
    .map((r) =>
      renderModel(r, resources, resourceHasOwnOnly(spec, r.name), extraByModel.get(pascal(r.name)) ?? []),
    )
    .join('\n\n')

  // Phase 1.1: API-key storage model — emitted whenever apikey auth is active
  const apiKeyAuthEnabled =
    spec.auth?.strategy === 'apikey' || spec.auth?.apikey?.enabled === true
  const apiKeyModel = apiKeyAuthEnabled ? renderApiKeyModel() : null

  // Phase 1.2: JWT user system — emit User + RefreshToken when opted in.
  // Phase 1.3: extend User with back-relations for each ownOnly-owned resource.
  // Phase 1.4: extend User with `oauthAccounts` back-relation when OAuth is configured.
  // Phase 2.2: extend User with back-relations for any user-defined resource
  // that declares an explicit manyToOne / oneToOne to "User".
  const jwtUserSystemEnabled = spec.auth?.jwt?.enabled === true
  const oauthEnabled = (spec.auth?.oauth?.providers?.length ?? 0) > 0
  const userBackRelations = jwtUserSystemEnabled
    ? collectUserBackRelations(resources, ownedResources.map((r) => r.name))
    : []
  const jwtUserModels = jwtUserSystemEnabled
    ? renderJwtUserModels(userBackRelations, oauthEnabled)
    : []
  const oauthModel = oauthEnabled ? renderOAuthAccountModel() : null

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

function renderApiKeyModel(): string {
  return `model ApiKey {
  id         String    @id @default(uuid())
  keyHash    String    @unique
  keyPrefix  String
  name       String?
  role       String    @default("admin")
  revoked    Boolean   @default(false)
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())
}`
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
 * Collects the back-relations to emit on the User model:
 *   · `owned<Name>s` for resources owned via the ownOnly RBAC injection
 *   · `<name>s` (lowercased plural) for resources that declare a single
 *     explicit manyToOne / oneToOne to "User" in their `relations[]`
 *   · one named back-relation PER relation when a resource declares SEVERAL
 *     relations to User (e.g. `buyerId` + `sellerId`): without distinct field
 *     names and matching `@relation("…")` names Prisma raises P1012.
 *
 * Explicit relations and ownOnly injection are de-duplicated by target model
 * so a resource that is both ownOnly AND explicitly related to User contributes
 * the explicit relation only.
 */
function collectUserBackRelations(
  resources: ResourceDefinition[],
  ownedResourceNames: string[],
): UserBackRelation[] {
  const out: UserBackRelation[] = []
  const explicitModels = new Set<string>()

  for (const resource of resources) {
    const userRels = (resource.relations ?? []).filter(
      (rel) =>
        rel.resource === 'User' &&
        (rel.type === 'manyToOne' || rel.type === 'oneToOne'),
    )
    if (userRels.length === 0) continue
    const modelName = resource.name.charAt(0).toUpperCase() + resource.name.slice(1)
    explicitModels.add(modelName)

    if (userRels.length === 1) {
      out.push({ field: `${resource.name.toLowerCase()}s`, model: modelName })
    } else {
      // Multiple relations to User → emit one named back-relation each so the
      // FK side (rendered with the same name) pairs unambiguously.
      for (const rel of userRels) {
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

function renderJwtUserModels(backRelations: UserBackRelation[], includeOAuth: boolean): string[] {
  const extraLines: string[] = []
  if (includeOAuth) {
    extraLines.push(`  oauthAccounts OAuthAccount[]`)
  }
  for (const back of backRelations) {
    // Pad to 13 chars to align with the other User columns.
    const relClause = back.relationName ? ` @relation("${back.relationName}")` : ''
    extraLines.push(`  ${back.field.padEnd(13)} ${back.model}[]${relClause}`)
  }

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

  const refreshTokenModel = `model RefreshToken {
  id        String   @id @default(uuid())
  tokenHash String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  revoked   Boolean  @default(false)
  createdAt DateTime @default(now())
}`

  return [userModel, refreshTokenModel]
}

function renderOAuthAccountModel(): string {
  return `model OAuthAccount {
  id         String   @id @default(uuid())
  provider   String
  providerId String
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt  DateTime @default(now())
  @@unique([provider, providerId])
}`
}
