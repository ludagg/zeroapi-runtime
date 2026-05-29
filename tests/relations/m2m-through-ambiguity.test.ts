import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import { parseSpec } from '../../src/parser/index.js'
import type { ZeroAPISpec, SpecRelation, RelationDefinition } from '../../src/types/spec.js'

/**
 * Programmatically generated coverage for the ambiguous-relation bug.
 *
 * The failure mode: a model relates to the SAME target through more than one
 * field. The hardest instance is a many-to-many whose `through` table is ALSO a
 * first-class resource that is directly related to the endpoints — the m2m
 * back-relation and the direct relation describe the same FK and must NOT be
 * emitted twice. We enumerate every way the direct relation can be expressed,
 * on either / both endpoints, and assert the schema is unambiguous and valid.
 */

function prismaValidate(schema: string): string {
  const prismaBin = resolve(process.cwd(), 'node_modules/.bin/prisma')
  const dir = mkdtempSync(join(tmpdir(), 'zeroapi-m2m-ambig-'))
  const schemaPath = join(dir, 'schema.prisma')
  writeFileSync(schemaPath, schema)
  return execFileSync(prismaBin, ['validate', `--schema=${schemaPath}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: 'postgresql://u:p@localhost:5432/db' },
  })
}

const prismaInstalled = existsSync(resolve(process.cwd(), 'node_modules/.bin/prisma'))
const describeIfPrisma = prismaInstalled ? describe : describe.skip

/** How a direct endpoint↔through relation is expressed (besides the m2m). */
type DirectMode =
  | 'none' // only the m2m
  | 'endpoint-oneToMany' // endpoint declares oneToMany → through
  | 'through-manyToOne' // through declares manyToOne → endpoint

function modelBlock(schema: string, name: string): string {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
}

/**
 * Builds a spec: Order ↔ Product (m2m through OrderItem), with the direct
 * Order↔OrderItem and Product↔OrderItem relations expressed per `orderMode` /
 * `productMode`.
 */
function buildSpec(orderMode: DirectMode, productMode: DirectMode): ZeroAPISpec {
  const orderItemRelations: RelationDefinition[] = []
  const topLevel: SpecRelation[] = [
    { from: 'Order', to: 'Product', type: 'many-to-many', field: 'products', through: 'OrderItem' },
  ]

  const applyMode = (mode: DirectMode, endpoint: 'Order' | 'Product', fk: string) => {
    if (mode === 'endpoint-oneToMany') {
      topLevel.push({ from: endpoint, to: 'OrderItem', type: 'one-to-many', field: 'orderItems' })
    } else if (mode === 'through-manyToOne') {
      orderItemRelations.push({ type: 'manyToOne', resource: endpoint, field: fk, required: true })
    }
  }
  applyMode(orderMode, 'Order', 'orderId')
  applyMode(productMode, 'Product', 'productId')

  return {
    version: '1.0.0',
    name: `m2m-${orderMode}-${productMode}`,
    resources: [
      { name: 'Product', fields: { name: { type: 'string', required: true } } },
      { name: 'Order', fields: { total: { type: 'decimal', required: true } } },
      {
        name: 'OrderItem',
        fields: { quantity: { type: 'integer', required: true } },
        ...(orderItemRelations.length ? { relations: orderItemRelations } : {}),
      },
    ],
    relations: topLevel,
  }
}

const MODES: DirectMode[] = ['none', 'endpoint-oneToMany', 'through-manyToOne']
const combos: Array<[DirectMode, DirectMode]> = []
for (const o of MODES) for (const p of MODES) combos.push([o, p])

describeIfPrisma('m2m through-resource × direct relation — every combination is unambiguous', () => {
  it.each(combos)('orderMode=%s productMode=%s', (orderMode, productMode) => {
    const spec = parseSpec(buildSpec(orderMode, productMode))
    const schema = generatePrismaSchema(spec)

    // Each endpoint must reference OrderItem exactly once (no ambiguous pair).
    expect((modelBlock(schema, 'Product').match(/OrderItem\[\]/g) ?? []).length).toBe(1)
    expect((modelBlock(schema, 'Order').match(/OrderItem\[\]/g) ?? []).length).toBe(1)
    // OrderItem owns each FK column exactly once (no duplicate columns).
    const oi = modelBlock(schema, 'OrderItem')
    expect((oi.match(/^\s*orderId\s/gm) ?? []).length).toBe(1)
    expect((oi.match(/^\s*productId\s/gm) ?? []).length).toBe(1)

    const out = prismaValidate(schema)
    expect(out).toMatch(/is valid/)
  })
})

// ── General rule: 2+ relations to the same target are always disambiguated ────

describeIfPrisma('general ambiguity: any model with 2+ relations to one target', () => {
  it('two manyToOne to the same user-defined target', () => {
    const spec = parseSpec({
      version: '1.0.0',
      name: 'two-mto',
      resources: [
        { name: 'Warehouse', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Transfer',
          fields: { qty: { type: 'integer', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Warehouse', field: 'sourceId', required: true },
            { type: 'manyToOne', resource: 'Warehouse', field: 'destId', required: true },
          ],
        },
      ],
    })
    expect(prismaValidate(generatePrismaSchema(spec))).toMatch(/is valid/)
  })

  it('three relations to the same target', () => {
    const spec = parseSpec({
      version: '1.0.0',
      name: 'three-mto',
      resources: [
        { name: 'Node', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Edge',
          fields: { weight: { type: 'integer', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Node', field: 'aId', required: true },
            { type: 'manyToOne', resource: 'Node', field: 'bId', required: true },
            { type: 'manyToOne', resource: 'Node', field: 'cId', required: true },
          ],
        },
      ],
    })
    expect(prismaValidate(generatePrismaSchema(spec))).toMatch(/is valid/)
  })

  it('a m2m endpoint that is ALSO a plain FK target of the same model', () => {
    // Catalog ↔ Product (m2m) AND Catalog has a featured Product (manyToOne).
    const spec = parseSpec({
      version: '1.0.0',
      name: 'm2m-plus-fk',
      resources: [
        {
          name: 'Catalog',
          fields: { name: { type: 'string', required: true } },
          relations: [
            { type: 'manyToMany', resource: 'Product', through: 'CatalogProducts' },
            { type: 'manyToOne', resource: 'Product', field: 'featuredProductId' },
          ],
        },
        { name: 'Product', fields: { name: { type: 'string', required: true } } },
      ],
    })
    expect(prismaValidate(generatePrismaSchema(spec))).toMatch(/is valid/)
  })
})
