import type { ZeroAPISpec, ResourceDefinition } from '../types/spec.js'
import type { PrismaInclude } from '../store/resource-store.js'
import type { FilterMap, FilterCondition } from '../query/builder.js'
import {
  backArrayField, snakeToPascal, relationFieldBase, isSystemResourceName,
} from './index.js'

/**
 * Translates a route's `?include=` list into a native Prisma `include` tree,
 * supporting NESTED paths of any depth via dot notation
 * (`?include=comments.user`).
 *
 * The relation FIELD names produced here mirror exactly what the schema
 * generator emits (`planResourceRelations`), so the include keys line up with
 * the generated Prisma models:
 *
 *   manyToOne / oneToOne  → singular object field (`category`, `user`, or a
 *                           disambiguated stem like `buyer` when a model has
 *                           several relations to the same target)
 *   oneToMany             → pluralised back-array field (`comments`)
 *   manyToMany (through)  → the join back-array nested into the far side
 *                           (`hashtag` → { postHashtags: { include: { hashtag }}})
 *
 * Returns `{ ok: false, unknown }` for the first segment that doesn't resolve to
 * a relation, so the route can answer 400 with a clear message.
 */
export function buildPrismaInclude(
  resource: ResourceDefinition,
  spec: ZeroAPISpec,
  includePaths: string[],
): { ok: true; include: PrismaInclude } | { ok: false; unknown: string } {
  const root: PrismaInclude = {}

  for (const path of includePaths) {
    const segments = path.split('.').map((s) => s.trim()).filter(Boolean)
    let currentResource: ResourceDefinition | undefined = resource
    let cursor: PrismaInclude = root

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string
      if (!currentResource) return { ok: false, unknown: segment }
      const resolved = resolveRelationField(currentResource, segment, spec)
      if (!resolved) return { ok: false, unknown: segment }
      const isLast = i === segments.length - 1

      if (resolved.through) {
        // M2M: include the join back-array, then the far-side object inside it.
        const joinInclude = ensureNode(cursor, resolved.field)
        if (isLast) setLeaf(joinInclude, resolved.through)
        else cursor = ensureNode(joinInclude, resolved.through)
      } else if (isLast) {
        setLeaf(cursor, resolved.field)
      } else {
        cursor = ensureNode(cursor, resolved.field)
      }

      currentResource = resolved.targetResource
    }
  }

  return { ok: true, include: root }
}

interface ResolvedRelation {
  /** Prisma relation field on the current model. */
  field: string
  /** For M2M-through, the far-side object field nested inside the join. */
  through?: string
  /** The resource the path now points at (undefined for system targets). */
  targetResource?: ResourceDefinition
}

function resolveRelationField(
  resource: ResourceDefinition,
  segment: string,
  spec: ZeroAPISpec,
): ResolvedRelation | null {
  const rel = (resource.relations ?? []).find(
    (r) => r.resource.toLowerCase() === segment.toLowerCase(),
  )
  if (!rel) return null

  const target = spec.resources.find(
    (r) => r.name.toLowerCase() === rel.resource.toLowerCase(),
  )

  switch (rel.type) {
    case 'manyToOne':
    case 'oneToOne': {
      // Singular object field. Disambiguated stem when several owning relations
      // point at the same target (matches the schema generator).
      const sameTarget = (resource.relations ?? []).filter(
        (r) =>
          (r.type === 'manyToOne' || r.type === 'oneToOne') &&
          r.resource.toLowerCase() === rel.resource.toLowerCase(),
      ).length
      const field = sameTarget > 1 ? relationFieldBase(rel) : rel.resource.toLowerCase()
      return { field, ...(target ? { targetResource: target } : {}) }
    }

    case 'oneToMany': {
      return {
        field: backArrayField(pascal(rel.resource)),
        ...(target ? { targetResource: target } : {}),
      }
    }

    case 'manyToMany': {
      const joinModel = snakeToPascal(rel.through ?? `${pascal(resource.name)}${pascal(rel.resource)}`)
      return {
        field: backArrayField(joinModel),
        through: rel.resource.toLowerCase(),
        ...(target ? { targetResource: target } : {}),
      }
    }
  }

  // System relation (e.g. ?include=user when not in spec.resources) — singular.
  if (isSystemResourceName(rel.resource)) {
    return { field: rel.resource.toLowerCase() }
  }
  return null
}

/** Marks `parent[field]` as included (leaf), without clobbering a deeper node. */
function setLeaf(parent: PrismaInclude, field: string): void {
  if (parent[field] === undefined) parent[field] = true
}

/** Upgrades `parent[field]` to an include node and returns its nested include. */
function ensureNode(parent: PrismaInclude, field: string): PrismaInclude {
  const existing = parent[field]
  if (existing && typeof existing === 'object') {
    const node = existing as { include?: PrismaInclude }
    if (!node.include) node.include = {}
    return node.include
  }
  const node: { include: PrismaInclude } = { include: {} }
  parent[field] = node
  return node.include
}

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Splits a parsed filter map into a Prisma `where` for many-to-many relation
 * filters (e.g. `?hashtag=<id>` → `{ postHashtags: { some: { hashtagId: <id> }}}`)
 * and the remaining scalar filters (still applied in memory afterwards).
 *
 * Only synthetic-join M2M (the common Tag/Hashtag shape) is translated; scalar
 * filters and any non-M2M key pass through untouched in `remaining`.
 */
export function extractM2MFilters(
  resource: ResourceDefinition,
  filters: FilterMap,
): { where: Record<string, unknown>; remaining: FilterMap } {
  const where: Record<string, unknown> = {}
  const remaining: FilterMap = {}

  for (const [key, cond] of Object.entries(filters)) {
    const rel = (resource.relations ?? []).find(
      (r) => r.type === 'manyToMany' && r.resource.toLowerCase() === key.toLowerCase(),
    )
    if (!rel) {
      remaining[key] = cond
      continue
    }
    const joinModel = snakeToPascal(rel.through ?? `${pascal(resource.name)}${pascal(rel.resource)}`)
    const joinField = backArrayField(joinModel)
    const targetFk = `${rel.resource.toLowerCase()}Id`
    const value = conditionToPrisma(cond)
    if (value !== undefined) {
      where[joinField] = { some: { [targetFk]: value } }
    }
  }

  return { where, remaining }
}

/** Maps a parsed FilterCondition to a Prisma scalar filter value. */
function conditionToPrisma(cond: FilterCondition): unknown {
  if (cond.eq !== undefined) return cond.eq
  const out: Record<string, unknown> = {}
  if (cond.in) out['in'] = cond.in
  if (cond.notin) out['notIn'] = cond.notin
  if (cond.ne !== undefined) out['not'] = cond.ne
  if (cond.gt !== undefined) out['gt'] = cond.gt
  if (cond.gte !== undefined) out['gte'] = cond.gte
  if (cond.lt !== undefined) out['lt'] = cond.lt
  if (cond.lte !== undefined) out['lte'] = cond.lte
  if (cond.contains !== undefined) out['contains'] = cond.contains
  return Object.keys(out).length > 0 ? out : undefined
}
