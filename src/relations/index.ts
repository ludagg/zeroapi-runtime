import { randomUUID } from 'crypto'
import type {
  ZeroAPISpec, ResourceDefinition, RelationDefinition, SpecRelation,
} from '../types/spec.js'
import { toPlural } from '../utils/plural.js'
import type { DataStore } from '../generators/routes.js'

type Row = Record<string, unknown>

// ── System resources ──────────────────────────────────────────────────────────

/**
 * System resources created by the runtime (not declared in spec.resources)
 * that user-defined resources may still relate to, provided the corresponding
 * auth feature is active.
 */
export const SYSTEM_RESOURCES = ['User', 'RefreshToken', 'OAuthAccount', 'ApiKey'] as const
export type SystemResourceName = typeof SYSTEM_RESOURCES[number]

/** Public-safe field names for each system resource. Sensitive columns
 *  (passwordHash, salt, tokenHash, …) are never returned via `?include=`. */
export const SYSTEM_RESOURCE_SAFE_FIELDS: Record<SystemResourceName, string[]> = {
  User: ['id', 'email', 'role', 'emailVerified', 'createdAt', 'updatedAt'],
  RefreshToken: ['id', 'userId', 'expiresAt', 'revoked', 'createdAt'],
  OAuthAccount: ['id', 'provider', 'providerId', 'userId', 'createdAt'],
  ApiKey: ['id', 'keyPrefix', 'name', 'role', 'revoked', 'lastUsedAt', 'createdAt'],
}

/** True when a resource name corresponds to a system resource. */
export function isSystemResourceName(name: string): name is SystemResourceName {
  return (SYSTEM_RESOURCES as readonly string[]).includes(name)
}

/** True when the named system resource is active for the given spec — i.e.
 *  the auth feature that creates it is enabled. */
export function isSystemResourceActive(spec: ZeroAPISpec, name: string): boolean {
  if (name === 'User' || name === 'RefreshToken') return spec.auth?.jwt?.enabled === true
  if (name === 'OAuthAccount') return (spec.auth?.oauth?.providers?.length ?? 0) > 0
  if (name === 'ApiKey') {
    return spec.auth?.strategy === 'apikey' || spec.auth?.apikey?.enabled === true
  }
  return false
}

/** Projects a system-resource row down to the public-safe fields. */
export function projectSystemResource(name: SystemResourceName, row: Row | null | undefined): Row | null {
  if (!row) return null
  const allowed = SYSTEM_RESOURCE_SAFE_FIELDS[name]
  const out: Row = {}
  for (const key of allowed) {
    if (key in row) out[key] = row[key]
  }
  return out
}

/**
 * Async resolver for a single system-resource record by id.
 * Returns the safe-projected row, or null when the id is unknown.
 */
export type SystemResourceResolver = (id: string) => Promise<Row | null>

/**
 * Map of system-resource resolvers, keyed by the lowercased relation name
 * (e.g. `user`). Set up by the runtime when the matching auth feature is on.
 */
export type SystemResourceResolvers = Record<string, SystemResourceResolver>

// ── Prisma schema helpers ─────────────────────────────────────────────────────

/** FK field name on the owning side of a manyToOne / oneToOne relation. */
export function fkFieldOf(rel: RelationDefinition): string {
  return rel.field ?? `${rel.resource.toLowerCase()}Id`
}

/**
 * Relation field "base" derived from the FK column by stripping a trailing
 * `Id` (e.g. `buyerId` → `buyer`, `category_id` → `category`). Used to give
 * each relation a unique field name when a model has several relations to the
 * same target. Falls back to the lowercased target name.
 */
export function relationFieldBase(rel: RelationDefinition): string {
  const fk = fkFieldOf(rel)
  const base = fk.replace(/_?[iI][dD]$/, '')
  return base.length > 0 ? base : rel.resource.toLowerCase()
}

/**
 * Deterministic, schema-unique `@relation("…")` name shared by BOTH endpoints
 * of a relation that needs disambiguation. `ownerModel` is the PascalCase
 * model that owns the FK; both sides must emit the identical string or Prisma
 * cannot pair them (P1012).
 */
export function relationLinkName(ownerModel: string, rel: RelationDefinition): string {
  return `${ownerModel}_${relationFieldBase(rel)}`
}

/**
 * Pads a Prisma field name so the following type token can never glue to it.
 * Short names align to column 14 (matching renderField); names ≥13 chars still
 * get at least one separating space — without this a 14-char FK like
 * `oauthAccountId` would render as `oauthAccountIdString`, which Prisma rejects.
 */
export function padFieldName(name: string): string {
  return name.padEnd(Math.max(14, name.length + 1))
}

/** Owning-side relations (manyToOne / oneToOne) of a resource. */
function owningRelations(resource: ResourceDefinition): RelationDefinition[] {
  return (resource.relations ?? []).filter(
    (r) => r.type === 'manyToOne' || r.type === 'oneToOne',
  )
}

/**
 * Counts, per target model, how many owning-side relations a resource has.
 * A target reached more than once is "ambiguous" — every relation to it must
 * carry an explicit, matching `@relation("…")` name on both sides.
 */
function owningTargetCounts(resource: ResourceDefinition): Map<string, number> {
  const counts = new Map<string, number>()
  for (const rel of owningRelations(resource)) {
    counts.set(rel.resource, (counts.get(rel.resource) ?? 0) + 1)
  }
  return counts
}

export function renderRelationFields(
  resource: ResourceDefinition,
  allResources: ResourceDefinition[]
): string[] {
  const lines: string[] = []
  const sourceModel = snakeToPascal(resource.name)
  // Targets this resource relates to more than once need named relations.
  const targetCounts = owningTargetCounts(resource)

  for (const rel of resource.relations ?? []) {
    const modelName = rel.resource.charAt(0).toUpperCase() + rel.resource.slice(1)
    const onDelete = rel.onDelete ? `, onDelete: ${rel.onDelete}` : ''
    const isSelf = rel.resource === resource.name

    switch (rel.type) {
      case 'manyToOne':
      case 'oneToOne': {
        const fk = fkFieldOf(rel)
        const opt = rel.required ? '' : '?'
        // A self relation ALWAYS needs an explicit @relation name AND a
        // back-relation field on the SAME model (Prisma cannot infer the
        // opposite side otherwise). A target reached more than once needs the
        // same disambiguation so we never emit two `user User` fields.
        const ambiguous = isSelf || (targetCounts.get(rel.resource) ?? 0) > 1
        const fieldName = ambiguous ? relationFieldBase(rel) : rel.resource.toLowerCase()
        const linkName = relationLinkName(sourceModel, rel)
        const nameArg = ambiguous ? `"${linkName}", ` : ''
        const fkUnique = rel.type === 'oneToOne' ? ' @unique' : ''
        lines.push(`  ${padFieldName(fk)}String${opt}${fkUnique}`)
        lines.push(`  ${padFieldName(fieldName)}${modelName}${opt}   @relation(${nameArg}fields: [${fk}], references: [id]${onDelete})`)
        if (isSelf) {
          // Opposite (array) side of the self relation, sharing the link name.
          const backField = `${relationFieldBase(rel)}${modelName}s`
          lines.push(`  ${padFieldName(backField)}${modelName}[] @relation("${linkName}")`)
        }
        break
      }
      case 'oneToMany': {
        if (isSelf) {
          // A self oneToMany paired with a self manyToOne/oneToOne is already
          // covered (that branch emits the named back array) — skip to avoid an
          // ambiguous duplicate. Declared alone, synthesise the owning side so
          // Prisma sees a complete, named self relation.
          const hasOwningSelf = (resource.relations ?? []).some(
            (r) => r.resource === resource.name && (r.type === 'manyToOne' || r.type === 'oneToOne'),
          )
          if (hasOwningSelf) break
          const linkName = `${sourceModel}_parent`
          lines.push(`  ${padFieldName('parentId')}String?`)
          lines.push(`  ${padFieldName('parent')}${modelName}?   @relation("${linkName}", fields: [parentId], references: [id]${onDelete})`)
          lines.push(`  ${padFieldName(`${rel.resource.toLowerCase()}s`)}${modelName}[] @relation("${linkName}")`)
          break
        }
        // No FK on this side — the FK lives on the target model
        lines.push(`  ${padFieldName(`${rel.resource.toLowerCase()}s`)}${modelName}[]`)
        break
      }
      case 'manyToMany': {
        // Use explicit join model
        const joinModel = snakeToPascal(rel.through ?? `${resource.name}${modelName}`)
        lines.push(`  ${padFieldName(`${rel.resource.toLowerCase()}s`)}${joinModel}[]`)
        break
      }
    }
  }

  // Reverse (back-relation) array fields for OTHER resources' owning-side
  // relations that point here. When a single `other` model owns several FK
  // relations to this resource, the back-relations are ambiguous: each needs a
  // unique field name and the matching @relation("…") name so both sides pair.
  for (const other of allResources) {
    if (other.name === resource.name) continue
    const otherModel = other.name.charAt(0).toUpperCase() + other.name.slice(1)
    const incoming = owningRelations(other).filter((r) => r.resource === resource.name)
    const ambiguous = incoming.length > 1

    for (const rel of incoming) {
      if (ambiguous) {
        const field = `${relationFieldBase(rel)}${otherModel}s`
        lines.push(`  ${padFieldName(field)}${otherModel}[] @relation("${relationLinkName(otherModel, rel)}")`)
      } else {
        // Skip when this resource already declares the inverse oneToMany / m2m.
        const alreadyDeclared = resource.relations?.some(
          (r) => r.resource === other.name && (r.type === 'oneToMany' || r.type === 'manyToMany'),
        )
        if (alreadyDeclared) continue
        lines.push(`  ${padFieldName(`${other.name.toLowerCase()}s`)}${otherModel}[]`)
      }
    }
  }

  return lines
}

export function renderJoinModels(
  resource: ResourceDefinition,
  allResources: ResourceDefinition[]
): string[] {
  const models: string[] = []

  for (const rel of resource.relations ?? []) {
    if (rel.type !== 'manyToMany') continue

    const thisModel  = resource.name.charAt(0).toUpperCase() + resource.name.slice(1)
    const otherModel = rel.resource.charAt(0).toUpperCase() + rel.resource.slice(1)
    const joinModel  = snakeToPascal(rel.through ?? `${thisModel}${otherModel}`)
    const thisFk     = `${resource.name.toLowerCase()}Id`
    const otherFk    = `${rel.resource.toLowerCase()}Id`

    const extraFields = Object.entries(rel.fields ?? {}).map(([name, field]) => {
      const prismaType = FIELD_TYPE_MAP[field.type] ?? 'String'
      const opt = field.required ? '' : '?'
      return `  ${padFieldName(name)}${prismaType}${opt}`
    })

    const onDelete = rel.onDelete ? `, onDelete: ${rel.onDelete}` : ''
    models.push(
      `model ${joinModel} {\n` +
      `  ${padFieldName(thisFk)}String\n` +
      `  ${padFieldName(otherFk)}String\n` +
      extraFields.join('\n') + (extraFields.length ? '\n' : '') +
      `  ${padFieldName(resource.name.toLowerCase())}${thisModel}  @relation(fields: [${thisFk}], references: [id]${onDelete})\n` +
      `  ${padFieldName(rel.resource.toLowerCase())}${otherModel}  @relation(fields: [${otherFk}], references: [id]${onDelete})\n` +
      `\n  @@id([${thisFk}, ${otherFk}])\n}`
    )

    // Prevent generating the same join model from the other side
    const other = allResources.find((r) => r.name === rel.resource)
    if (other) {
      other.relations = (other.relations ?? []).filter(
        (r) => !(r.type === 'manyToMany' && r.through === rel.through)
      )
    }
  }

  return models
}

// ── Top-level → per-resource normalization (Phase 2.1) ────────────────────────

/**
 * Maps a top-level `onDelete` token (cascade/set-null/restrict) to the
 * per-resource Prisma form (Cascade/SetNull/Restrict).
 */
function mapTopLevelOnDelete(
  onDelete: SpecRelation['onDelete'],
): RelationDefinition['onDelete'] | undefined {
  if (onDelete === 'cascade')  return 'Cascade'
  if (onDelete === 'set-null') return 'SetNull'
  if (onDelete === 'restrict') return 'Restrict'
  return undefined
}

/**
 * Returns a shallow copy of the spec where each top-level `relations[]` entry
 * has been merged into the matching resource's per-resource `relations[]`.
 * The original `spec.relations` block is preserved unchanged.
 *
 * The mapping mirrors how Prisma sees the same shapes:
 *   many-to-one  A→B  field=fk → A.manyToOne(B, field=fk)
 *   one-to-many  A→B           → A.oneToMany(B) + B.manyToOne(A, field=`{a}Id`)
 *   one-to-one   A→B  field=fk → A.oneToOne(B, field=fk)
 *   many-to-many A→B  through  → A.manyToMany(B, through)
 *
 * Duplicates (per-resource entry already covers the same target) are skipped.
 */
export function normalizeTopLevelRelations(spec: ZeroAPISpec): ZeroAPISpec {
  if (!spec.relations || spec.relations.length === 0) return spec

  const resources = spec.resources.map((r) => ({
    ...r,
    relations: [...(r.relations ?? [])],
  }))
  const byName = new Map(resources.map((r) => [r.name, r]))

  const hasRel = (
    res: ResourceDefinition,
    targetName: string,
    types: RelationDefinition['type'][],
  ): boolean =>
    (res.relations ?? []).some((r) => r.resource === targetName && types.includes(r.type))

  for (const sr of spec.relations) {
    const from = byName.get(sr.from)
    const to   = byName.get(sr.to)
    // The `to` side may be a system resource (e.g. User when auth.jwt is on),
    // in which case it isn't present in byName but the relation is still valid.
    const toIsSystem = !to && isSystemResourceName(sr.to) && isSystemResourceActive(spec, sr.to)
    if (!from || (!to && !toIsSystem)) continue

    const onDeletePrisma = mapTopLevelOnDelete(sr.onDelete)

    switch (sr.type) {
      case 'many-to-one': {
        if (!hasRel(from, sr.to, ['manyToOne'])) {
          from.relations!.push({
            type: 'manyToOne',
            resource: sr.to,
            field: sr.field,
            ...(onDeletePrisma ? { onDelete: onDeletePrisma } : {}),
          })
        }
        break
      }
      case 'one-to-many': {
        if (!hasRel(from, sr.to, ['oneToMany'])) {
          from.relations!.push({ type: 'oneToMany', resource: sr.to })
        }
        if (to && !hasRel(to, sr.from, ['manyToOne'])) {
          to.relations!.push({
            type: 'manyToOne',
            resource: sr.from,
            field: `${sr.from.toLowerCase()}Id`,
            ...(onDeletePrisma ? { onDelete: onDeletePrisma } : {}),
          })
        }
        break
      }
      case 'one-to-one': {
        if (!hasRel(from, sr.to, ['oneToOne'])) {
          from.relations!.push({
            type: 'oneToOne',
            resource: sr.to,
            field: sr.field,
            ...(onDeletePrisma ? { onDelete: onDeletePrisma } : {}),
          })
        }
        break
      }
      case 'many-to-many': {
        if (!hasRel(from, sr.to, ['manyToMany']) && sr.through) {
          from.relations!.push({
            type: 'manyToMany',
            resource: sr.to,
            through: sr.through,
            ...(onDeletePrisma ? { onDelete: onDeletePrisma } : {}),
          })
        }
        break
      }
    }
  }

  return { ...spec, resources }
}

// ── Runtime include resolver ──────────────────────────────────────────────────

/** Result of validating an `?include=` list against a resource's relations. */
export interface IncludeValidationResult {
  ok: boolean
  unknown?: string
}

/**
 * Validates each name in an `?include=` list against the resource's relations.
 * Returns the first unknown name so callers can return 400 with a clear message.
 */
export function validateIncludes(
  includeList: string[],
  resource: ResourceDefinition,
): IncludeValidationResult {
  if (includeList.length === 0) return { ok: true }
  const relations = resource.relations ?? []
  for (const name of includeList) {
    const matched = relations.some(
      (r) => r.resource.toLowerCase() === name.toLowerCase(),
    )
    if (!matched) return { ok: false, unknown: name }
  }
  return { ok: true }
}

/** True when the named resource has at least one ownOnly permission rule. */
function resourceHasOwnOnly(spec: ZeroAPISpec, resourceName: string): boolean {
  return (spec.permissions ?? []).some(
    (p) => p.resource === resourceName && p.rules.some((r) => r.ownOnly),
  )
}

/** Optional ownership context used by `?include=` to drop rows the requester
 *  cannot see (i.e. ownOnly rules on the included relation). */
export interface IncludeOwnershipContext {
  /** Authenticated user id, when the request comes from a JWT identity. */
  userId?: string
}

/**
 * Resolves `?include=` relations for a list of items, doing in-memory joins.
 * When the included resource has an ownOnly permission rule and a userId is
 * provided, rows the requester does not own are filtered out before they are
 * attached to the response — preserving the same visibility as a direct list.
 *
 * System-resource relations (e.g. `?include=user` when auth.jwt is enabled)
 * are loaded via the supplied async resolvers and projected down to the
 * public-safe fields so sensitive columns (passwordHash, salt, …) never
 * cross the API boundary.
 */
export async function applyIncludes(
  items: Row[],
  includeList: string[],
  resource: ResourceDefinition,
  spec: ZeroAPISpec,
  store: DataStore,
  ownership?: IncludeOwnershipContext,
  systemResolvers?: SystemResourceResolvers,
): Promise<Row[]> {
  if (includeList.length === 0 || !resource.relations?.length) return items

  const out: Row[] = []
  for (const item of items) {
    const enriched: Row = { ...item }

    for (const includeName of includeList) {
      const rel = resource.relations?.find(
        (r) => r.resource.toLowerCase() === includeName.toLowerCase(),
      )
      if (!rel) continue

      let related: unknown
      if (isSystemResourceName(rel.resource) && isSystemResourceActive(spec, rel.resource)) {
        related = await resolveSystemRelation(item, rel, systemResolvers)
      } else {
        related = resolveRelation(item, rel, resource, spec, store)
      }

      // ownOnly filtering: when the included resource has an ownOnly rule and we
      // know the requester's userId, drop rows they do not own. Without an
      // identity we can't decide — be conservative and return null/empty.
      if (resourceHasOwnOnly(spec, rel.resource)) {
        const ownerId = ownership?.userId
        if (Array.isArray(related)) {
          related = ownerId
            ? related.filter((r) => (r as Row)['userId'] === ownerId)
            : []
        } else if (related && typeof related === 'object') {
          if (!ownerId || (related as Row)['userId'] !== ownerId) related = null
        }
      }

      enriched[includeName.toLowerCase()] = related
    }

    out.push(enriched)
  }
  return out
}

async function resolveSystemRelation(
  item: Row,
  rel: RelationDefinition,
  resolvers?: SystemResourceResolvers,
): Promise<unknown> {
  // Only manyToOne / oneToOne (the user-defined resource owns the FK) is supported
  // for system targets — user-defined resources do not back-reference into the
  // system tables via a routes-level `?include`.
  if (rel.type !== 'manyToOne' && rel.type !== 'oneToOne') return null
  const targetKey = rel.resource.toLowerCase()
  const resolver = resolvers?.[targetKey]
  if (!resolver) return null
  const fk = rel.field ?? `${targetKey}Id`
  const fkValue = item[fk] as string | undefined
  if (!fkValue) return null
  const row = await resolver(fkValue)
  if (!row) return null
  return projectSystemResource(rel.resource as SystemResourceName, row)
}

function resolveRelation(
  item: Row,
  rel: RelationDefinition,
  resource: ResourceDefinition,
  spec: ZeroAPISpec,
  store: DataStore
): unknown {
  const targetKey = rel.resource.toLowerCase()

  switch (rel.type) {
    case 'manyToOne':
    case 'oneToOne': {
      const fk = rel.field ?? `${targetKey}Id`
      const fkValue = item[fk] as string | undefined
      if (!fkValue) return null
      return store.get(targetKey)?.get(fkValue) ?? null
    }

    case 'oneToMany': {
      // Find FK field on the target resource that points to this resource
      const targetResource = spec.resources.find(
        (r) => r.name.toLowerCase() === targetKey
      )
      const reverseRel = targetResource?.relations?.find(
        (r) => r.resource.toLowerCase() === resource.name.toLowerCase() &&
               (r.type === 'manyToOne' || r.type === 'oneToOne')
      )
      const fkField = reverseRel?.field ?? `${resource.name.toLowerCase()}Id`
      const itemId = item['id'] as string
      return Array.from(store.get(targetKey)?.values() ?? []).filter(
        (row) => row[fkField] === itemId
      )
    }

    case 'manyToMany': {
      const throughKey = rel.through ?? `${resource.name.toLowerCase()}_${targetKey}s`
      const thisFk  = `${resource.name.toLowerCase()}Id`
      const otherFk = `${targetKey}Id`
      const itemId  = item['id'] as string

      const joinRows = Array.from(store.get(throughKey)?.values() ?? []).filter(
        (row) => row[thisFk] === itemId
      )

      return joinRows.map((joinRow) => {
        const related = store.get(targetKey)?.get(joinRow[otherFk] as string)
        if (!related) return joinRow
        // Merge join table extra fields into the related record
        const extra = Object.entries(joinRow).filter(
          ([k]) => k !== thisFk && k !== otherFk && k !== 'id'
        )
        return { ...related, ...Object.fromEntries(extra) }
      })
    }
  }
}

/**
 * Handles nested relation data in a POST body.
 * Returns { body: the primary fields, nested: relation data to persist }.
 */
export function extractNestedRelations(
  rawBody: Record<string, unknown>,
  resource: ResourceDefinition
): { body: Record<string, unknown>; nested: Array<{ rel: RelationDefinition; items: Row[] }> } {
  const body: Record<string, unknown> = { ...rawBody }
  const nested: Array<{ rel: RelationDefinition; items: Row[] }> = []

  for (const rel of resource.relations ?? []) {
    if (rel.type !== 'manyToMany') continue
    const key = toPlural(rel.resource)
    if (!Array.isArray(body[key])) continue

    nested.push({ rel, items: body[key] as Row[] })
    delete body[key]
  }

  return { body, nested }
}

/**
 * Persists nested manyToMany records into the join table store.
 */
export function persistNestedRelations(
  parentId: string,
  nested: Array<{ rel: RelationDefinition; items: Row[] }>,
  resource: ResourceDefinition,
  store: DataStore
): void {
  for (const { rel, items } of nested) {
    const throughKey = rel.through ?? `${resource.name.toLowerCase()}_${rel.resource.toLowerCase()}s`
    if (!store.has(throughKey)) store.set(throughKey, new Map())
    const joinStore = store.get(throughKey)!

    const thisFk  = `${resource.name.toLowerCase()}Id`
    const otherFk = `${rel.resource.toLowerCase()}Id`

    const relatedStore = store.get(rel.resource.toLowerCase())

    for (const item of items) {
      const relatedId = (item[otherFk] ?? item['id']) as string | undefined
      if (!relatedId) {
        throw new Error(`Nested relation item for ${rel.resource} is missing "${otherFk}"`)
      }
      if (!relatedStore?.has(relatedId)) {
        throw new Error(`${rel.resource} with id "${relatedId}" not found — nested items must reference existing records`)
      }

      const extraFields = Object.entries(rel.fields ?? {}).reduce<Row>((acc, [name]) => {
        if (item[name] !== undefined) acc[name] = item[name]
        return acc
      }, {})

      const joinRecord: Row = {
        id: randomUUID(),
        [thisFk]: parentId,
        [otherFk]: relatedId,
        ...extraFields,
      }
      joinStore.set(`${parentId}:${relatedId}`, joinRecord)
    }
  }
}

// ── System-resource cascade ───────────────────────────────────────────────────

/** Outcome of a system-resource cascade. Lists ids touched on each user-defined
 *  resource so callers can audit / verify the operation. */
export interface CascadeResult {
  deleted: Record<string, string[]>
  setNull: Record<string, string[]>
  restricted: Array<{ resource: string; count: number }>
}

/**
 * Applies cascade semantics to the in-memory `DataStore` when a system
 * resource (e.g. a User) is deleted. Walks every user-defined resource that
 * has a `manyToOne` / `oneToOne` relation back to `systemResource` and
 * enforces the relation's `onDelete` policy:
 *
 *   · Cascade  → child rows are deleted
 *   · SetNull  → child FK is cleared (the row stays)
 *   · Restrict → throws when any child row references the system row
 *
 * Returns a summary so tests + audit logs can verify behaviour. Throws on the
 * first Restrict violation; nothing is mutated in that case.
 */
export function cascadeSystemResourceDelete(
  spec: ZeroAPISpec,
  store: DataStore,
  systemResource: string,
  id: string,
): CascadeResult {
  const result: CascadeResult = { deleted: {}, setNull: {}, restricted: [] }

  // First pass: Restrict — bail before mutating anything
  for (const resource of spec.resources) {
    for (const rel of resource.relations ?? []) {
      if (rel.resource !== systemResource) continue
      if (rel.type !== 'manyToOne' && rel.type !== 'oneToOne') continue
      if (rel.onDelete !== 'Restrict') continue
      const fk = rel.field ?? `${systemResource.toLowerCase()}Id`
      const key = resource.name.toLowerCase()
      const matches = Array.from(store.get(key)?.values() ?? []).filter(
        (row) => row[fk] === id,
      )
      if (matches.length > 0) {
        result.restricted.push({ resource: resource.name, count: matches.length })
        throw new Error(
          `Cannot delete ${systemResource} "${id}" — ${matches.length} ${resource.name} row(s) still reference it (onDelete: Restrict)`,
        )
      }
    }
  }

  // Second pass: Cascade + SetNull
  for (const resource of spec.resources) {
    for (const rel of resource.relations ?? []) {
      if (rel.resource !== systemResource) continue
      if (rel.type !== 'manyToOne' && rel.type !== 'oneToOne') continue
      const fk = rel.field ?? `${systemResource.toLowerCase()}Id`
      const key = resource.name.toLowerCase()
      const bucket = store.get(key)
      if (!bucket) continue

      const matchedIds: string[] = []
      for (const [rowId, row] of bucket.entries()) {
        if (row[fk] !== id) continue
        matchedIds.push(rowId)
      }

      if (rel.onDelete === 'Cascade') {
        for (const rowId of matchedIds) bucket.delete(rowId)
        if (matchedIds.length > 0) result.deleted[resource.name] = matchedIds
      } else if (rel.onDelete === 'SetNull') {
        for (const rowId of matchedIds) {
          const row = bucket.get(rowId)
          if (row) {
            row[fk] = null
            row['updatedAt'] = new Date().toISOString()
          }
        }
        if (matchedIds.length > 0) result.setNull[resource.name] = matchedIds
      }
      // NoAction (or unset) → leave the FK pointing at a now-missing row
    }
  }

  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function snakeToPascal(str: string): string {
  return str
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

const FIELD_TYPE_MAP: Record<string, string> = {
  string: 'String', text: 'String', email: 'String', url: 'String', uuid: 'String',
  number: 'Float', integer: 'Int', boolean: 'Boolean',
  date: 'DateTime', datetime: 'DateTime', file: 'String',
}
