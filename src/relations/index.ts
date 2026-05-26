import { randomUUID } from 'crypto'
import type { ZeroAPISpec, ResourceDefinition, RelationDefinition } from '../types/spec.js'
import { toPlural } from '../utils/plural.js'
import type { DataStore } from '../generators/routes.js'

type Row = Record<string, unknown>

// ── Prisma schema helpers ─────────────────────────────────────────────────────

export function renderRelationFields(
  resource: ResourceDefinition,
  allResources: ResourceDefinition[]
): string[] {
  const lines: string[] = []

  for (const rel of resource.relations ?? []) {
    const modelName = rel.resource.charAt(0).toUpperCase() + rel.resource.slice(1)
    const onDelete = rel.onDelete ? ` onDelete: ${rel.onDelete}` : ''

    switch (rel.type) {
      case 'manyToOne': {
        const fk = rel.field ?? `${rel.resource.toLowerCase()}Id`
        const opt = rel.required ? '' : '?'
        lines.push(`  ${fk.padEnd(14)}String${opt}`)
        lines.push(`  ${rel.resource.toLowerCase().padEnd(14)}${modelName}${opt}   @relation(fields: [${fk}], references: [id]${onDelete})`)
        break
      }
      case 'oneToOne': {
        // Owned side: has the FK
        const fk = rel.field ?? `${rel.resource.toLowerCase()}Id`
        const opt = rel.required ? '' : '?'
        lines.push(`  ${fk.padEnd(14)}String${opt} @unique`)
        lines.push(`  ${rel.resource.toLowerCase().padEnd(14)}${modelName}${opt}   @relation(fields: [${fk}], references: [id]${onDelete})`)
        break
      }
      case 'oneToMany': {
        // No FK on this side — the FK lives on the target model
        lines.push(`  ${rel.resource.toLowerCase()}s${' '.repeat(Math.max(0, 13 - rel.resource.length))} ${modelName}[]`)
        break
      }
      case 'manyToMany': {
        // Use explicit join model
        const joinModel = snakeToPascal(rel.through ?? `${resource.name}${modelName}`)
        lines.push(`  ${rel.resource.toLowerCase()}s${' '.repeat(Math.max(0, 13 - rel.resource.length))} ${joinModel}[]`)
        break
      }
    }
  }

  // Add reverse oneToMany fields from other resources pointing here
  for (const other of allResources) {
    if (other.name === resource.name) continue
    for (const rel of other.relations ?? []) {
      if (rel.resource !== resource.name) continue
      if (rel.type === 'manyToOne' || rel.type === 'oneToOne') {
        // This resource is the "one" side — add an array back-reference
        const alreadyDeclared = resource.relations?.some(
          (r) => r.resource === other.name && (r.type === 'oneToMany' || r.type === 'manyToMany')
        )
        if (!alreadyDeclared) {
          const otherModel = other.name.charAt(0).toUpperCase() + other.name.slice(1)
          lines.push(`  ${other.name.toLowerCase()}s${' '.repeat(Math.max(0, 13 - other.name.length))} ${otherModel}[]`)
        }
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
      return `  ${name.padEnd(14)}${prismaType}${opt}`
    })

    const onDelete = rel.onDelete ? ` onDelete: ${rel.onDelete}` : ''
    models.push(
      `model ${joinModel} {\n` +
      `  ${thisFk.padEnd(14)}String\n` +
      `  ${otherFk.padEnd(14)}String\n` +
      extraFields.join('\n') + (extraFields.length ? '\n' : '') +
      `  ${resource.name.toLowerCase().padEnd(14)}${thisModel}  @relation(fields: [${thisFk}], references: [id]${onDelete})\n` +
      `  ${rel.resource.toLowerCase().padEnd(14)}${otherModel}  @relation(fields: [${otherFk}], references: [id]${onDelete})\n` +
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

// ── Runtime include resolver ──────────────────────────────────────────────────

/**
 * Resolves `?include=` relations for a list of items, doing in-memory joins.
 */
export function applyIncludes(
  items: Row[],
  includeList: string[],
  resource: ResourceDefinition,
  spec: ZeroAPISpec,
  store: DataStore
): Row[] {
  if (includeList.length === 0 || !resource.relations?.length) return items

  return items.map((item) => {
    const enriched: Row = { ...item }

    for (const includeName of includeList) {
      // Find matching relation by target resource name (case-insensitive)
      const rel = resource.relations?.find(
        (r) => r.resource.toLowerCase() === includeName.toLowerCase()
      )
      if (!rel) continue

      enriched[includeName.toLowerCase()] = resolveRelation(item, rel, resource, spec, store)
    }

    return enriched
  })
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
