import type { ZeroAPISpec, ResourceDefinition, AggregateOp } from '../types/spec.js'
import type { DataStore } from '../types/store.js'
import { prismaResourceDelegateName } from '../store/prisma-resource-store.js'
import { toPlural } from '../utils/plural.js'

type Row = Record<string, unknown>

/** An aggregate resolved to its child collection + foreign key. */
interface ResolvedAggregate {
  name: string
  op: AggregateOp
  field?: string
  /** Memory store key for the child collection (e.g. 'order'). */
  childKey: string
  /** Prisma delegate name for the child model (e.g. 'order'). */
  childDelegate: string
  /** FK column on the child pointing back at the parent (e.g. 'userId'). */
  fkField: string
}

/** Minimal Prisma client shape needed for batched aggregation. */
export interface PrismaGroupByDelegate {
  groupBy(args: {
    by: string[]
    where: Record<string, unknown>
    _count?: true
    _sum?: Record<string, true>
    _avg?: Record<string, true>
    _min?: Record<string, true>
    _max?: Record<string, true>
  }): Promise<Array<Record<string, unknown>>>
}
export interface PrismaAggregateClient {
  [delegate: string]: PrismaGroupByDelegate
}

/**
 * Splits an `?include=` list into relation includes and aggregate names
 * (the latter matching this resource's declared `aggregates[].name`).
 */
export function partitionIncludes(
  resource: ResourceDefinition,
  include: string[],
): { relationIncludes: string[]; aggregateIncludes: string[] } {
  const aggNames = new Set((resource.aggregates ?? []).map((a) => a.name.toLowerCase()))
  const relationIncludes: string[] = []
  const aggregateIncludes: string[] = []
  for (const token of include) {
    if (aggNames.has(token.toLowerCase())) aggregateIncludes.push(token)
    else relationIncludes.push(token)
  }
  return { relationIncludes, aggregateIncludes }
}

/** Resolves the requested aggregate names to their child collection + FK. */
export function resolveAggregates(
  resource: ResourceDefinition,
  spec: ZeroAPISpec,
  names: string[],
): ResolvedAggregate[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const out: ResolvedAggregate[] = []
  for (const agg of resource.aggregates ?? []) {
    if (!wanted.has(agg.name.toLowerCase())) continue
    const rel = (resource.relations ?? []).find(
      (r) =>
        r.type === 'oneToMany' &&
        (r.resource.toLowerCase() === agg.relation.toLowerCase() ||
          toPlural(r.resource).toLowerCase() === agg.relation.toLowerCase()),
    )
    if (!rel) continue
    const childDef = spec.resources.find((r) => r.name.toLowerCase() === rel.resource.toLowerCase())
    const reverse = childDef?.relations?.find(
      (r) =>
        (r.type === 'manyToOne' || r.type === 'oneToOne') &&
        r.resource.toLowerCase() === resource.name.toLowerCase(),
    )
    const fkField = reverse?.field ?? `${resource.name.toLowerCase()}Id`
    out.push({
      name: agg.name,
      op: agg.op,
      ...(agg.field ? { field: agg.field } : {}),
      childKey: rel.resource.toLowerCase(),
      childDelegate: prismaResourceDelegateName(rel.resource),
      fkField,
    })
  }
  return out
}

function defaultFor(op: AggregateOp): number | null {
  return op === 'count' || op === 'sum' ? 0 : null
}

/**
 * Attaches the requested aggregates to each row, IN PLACE.
 *
 * Anti-N+1: aggregates are grouped by (child delegate, fk) and each group is
 * resolved with ONE call — a single Prisma `groupBy` over `fk IN (pageIds)`
 * (or one in-memory fold) — regardless of how many rows are on the page.
 */
export async function applyAggregates(
  rows: Row[],
  resolved: ResolvedAggregate[],
  opts: { store?: DataStore; prismaClient?: PrismaAggregateClient },
): Promise<void> {
  if (rows.length === 0 || resolved.length === 0) return
  const parentIds = rows.map((r) => r['id']).filter((v): v is string => typeof v === 'string')
  if (parentIds.length === 0) return

  // Group aggregates that share the same child relation → one query per group.
  const groups = new Map<string, { childKey: string; childDelegate: string; fkField: string; aggs: ResolvedAggregate[] }>()
  for (const agg of resolved) {
    const key = `${agg.childDelegate}::${agg.fkField}`
    let g = groups.get(key)
    if (!g) { g = { childKey: agg.childKey, childDelegate: agg.childDelegate, fkField: agg.fkField, aggs: [] }; groups.set(key, g) }
    g.aggs.push(agg)
  }

  for (const group of groups.values()) {
    const byParent = opts.prismaClient
      ? await aggregateViaPrisma(opts.prismaClient, group, parentIds)
      : aggregateViaMemory(opts.store, group, parentIds)
    for (const row of rows) {
      const computed = byParent.get(row['id'] as string)
      for (const agg of group.aggs) {
        row[agg.name] = computed ? computed[agg.name] : defaultFor(agg.op)
      }
    }
  }
}

async function aggregateViaPrisma(
  client: PrismaAggregateClient,
  group: { childDelegate: string; fkField: string; aggs: ResolvedAggregate[] },
  parentIds: string[],
): Promise<Map<string, Record<string, number | null>>> {
  const _sum: Record<string, true> = {}
  const _avg: Record<string, true> = {}
  const _min: Record<string, true> = {}
  const _max: Record<string, true> = {}
  let needCount = false
  for (const agg of group.aggs) {
    if (agg.op === 'count') needCount = true
    else if (agg.field) {
      if (agg.op === 'sum') _sum[agg.field] = true
      else if (agg.op === 'avg') _avg[agg.field] = true
      else if (agg.op === 'min') _min[agg.field] = true
      else if (agg.op === 'max') _max[agg.field] = true
    }
  }
  const args = {
    by: [group.fkField],
    where: { [group.fkField]: { in: parentIds } },
    ...(needCount ? { _count: true as const } : {}),
    ...(Object.keys(_sum).length ? { _sum } : {}),
    ...(Object.keys(_avg).length ? { _avg } : {}),
    ...(Object.keys(_min).length ? { _min } : {}),
    ...(Object.keys(_max).length ? { _max } : {}),
  }
  const groupRows = await client[group.childDelegate]!.groupBy(args)

  const map = new Map<string, Record<string, number | null>>()
  for (const gr of groupRows) {
    const pid = gr[group.fkField] as string
    const rec: Record<string, number | null> = {}
    for (const agg of group.aggs) {
      if (agg.op === 'count') {
        rec[agg.name] = (gr['_count'] as number | undefined) ?? 0
      } else {
        const bucket = gr[`_${agg.op}`] as Record<string, number | null> | undefined
        rec[agg.name] = (bucket?.[agg.field as string] ?? defaultFor(agg.op))
      }
    }
    map.set(pid, rec)
  }
  return map
}

function aggregateViaMemory(
  store: DataStore | undefined,
  group: { childKey: string; fkField: string; aggs: ResolvedAggregate[] },
  parentIds: string[],
): Map<string, Record<string, number | null>> {
  const wanted = new Set(parentIds)
  const byParent = new Map<string, Row[]>()
  const childMap = store?.get(group.childKey)
  if (childMap) {
    for (const child of childMap.values()) {
      const pid = child[group.fkField]
      if (typeof pid !== 'string' || !wanted.has(pid)) continue
      const arr = byParent.get(pid) ?? []
      arr.push(child)
      byParent.set(pid, arr)
    }
  }

  const map = new Map<string, Record<string, number | null>>()
  for (const pid of parentIds) {
    const kids = byParent.get(pid) ?? []
    const rec: Record<string, number | null> = {}
    for (const agg of group.aggs) rec[agg.name] = fold(agg, kids)
    map.set(pid, rec)
  }
  return map
}

function fold(agg: ResolvedAggregate, kids: Row[]): number | null {
  if (agg.op === 'count') return kids.length
  const nums = kids
    .map((k) => Number(k[agg.field as string]))
    .filter((n) => Number.isFinite(n))
  if (agg.op === 'sum') return nums.reduce((a, b) => a + b, 0)
  if (nums.length === 0) return null
  if (agg.op === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length
  if (agg.op === 'min') return Math.min(...nums)
  return Math.max(...nums) // max
}
