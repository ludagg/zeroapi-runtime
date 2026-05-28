import { describe, it, expect } from 'vitest'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

/** Count how many times `model <Name> {` appears in a schema. */
function countModel(schema: string, name: string): number {
  return schema.match(new RegExp(`(^|\\n)model ${name} \\{`, 'g'))?.length ?? 0
}

/** Extract the body of a single model block. */
function modelBlock(schema: string, name: string): string {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
}

/**
 * Asserts the schema never declares the same model twice — the core
 * invariant Prisma enforces (P1012 otherwise).
 */
function assertNoDuplicateModels(schema: string): void {
  const names = [...schema.matchAll(/(^|\n)model (\w+) \{/g)].map((m) => m[2])
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  expect(dupes).toEqual([])
}

describe('many-to-many through a user-defined resource', () => {
  // CAS B — the user declares OrderItem with its own payload fields only;
  // the runtime must inject the FK columns + relations rather than emit a
  // second OrderItem model.
  const ecommerceSpec: ZeroAPISpec = {
    version: '1.0.0',
    name: 'ecommerce',
    resources: [
      {
        name: 'Order',
        fields: { total: { type: 'decimal', required: true } },
        relations: [
          { type: 'manyToMany', resource: 'Product', through: 'OrderItem' },
        ],
      },
      {
        name: 'Product',
        fields: {
          name: { type: 'string', required: true },
          price: { type: 'decimal', required: true },
        },
      },
      {
        name: 'OrderItem',
        fields: {
          quantity: { type: 'integer', required: true },
          priceAtPurchase: { type: 'decimal', required: true },
        },
      },
    ],
  }

  it('emits OrderItem exactly once (no P1012 duplicate)', () => {
    const schema = generatePrismaSchema(ecommerceSpec)
    expect(countModel(schema, 'OrderItem')).toBe(1)
    assertNoDuplicateModels(schema)
  })

  it('keeps the user-declared payload fields on OrderItem', () => {
    const block = modelBlock(generatePrismaSchema(ecommerceSpec), 'OrderItem')
    expect(block).toMatch(/quantity\s+Int/)
    expect(block).toMatch(/priceAtPurchase\s+Decimal/)
  })

  it('injects the FK columns and @relation fields into OrderItem', () => {
    const block = modelBlock(generatePrismaSchema(ecommerceSpec), 'OrderItem')
    expect(block).toMatch(/orderId\s+String/)
    expect(block).toMatch(/productId\s+String/)
    expect(block).toMatch(/order\s+Order\s+@relation\(fields: \[orderId\], references: \[id\]\)/)
    expect(block).toMatch(/product\s+Product\s+@relation\(fields: \[productId\], references: \[id\]\)/)
  })

  it('adds a composite @@unique on the FK pair', () => {
    const block = modelBlock(generatePrismaSchema(ecommerceSpec), 'OrderItem')
    expect(block).toContain('@@unique([orderId, productId])')
  })

  it('adds back-relation array fields on both endpoints', () => {
    const schema = generatePrismaSchema(ecommerceSpec)
    expect(modelBlock(schema, 'Order')).toMatch(/OrderItem\[\]/)
    expect(modelBlock(schema, 'Product')).toMatch(/OrderItem\[\]/)
  })

  // CAS A — the user already declares the FK columns on OrderItem. The runtime
  // must add the @relation fields + composite key without re-declaring the FK.
  it('does not duplicate FK columns the user already declared (CAS A)', () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'ecommerce-casA',
      resources: [
        {
          name: 'Order',
          fields: { total: { type: 'decimal', required: true } },
          relations: [{ type: 'manyToMany', resource: 'Product', through: 'OrderItem' }],
        },
        { name: 'Product', fields: { name: { type: 'string', required: true } } },
        {
          name: 'OrderItem',
          fields: {
            orderId: { type: 'string', required: true },
            productId: { type: 'string', required: true },
            quantity: { type: 'integer', required: true },
          },
        },
      ],
    }
    const block = modelBlock(generatePrismaSchema(spec), 'OrderItem')
    expect(block.match(/^\s*orderId\s/gm)?.length).toBe(1)
    expect(block.match(/^\s*productId\s/gm)?.length).toBe(1)
    expect(block).toMatch(/order\s+Order\s+@relation/)
    expect(block).toMatch(/product\s+Product\s+@relation/)
    expect(block).toContain('@@unique([orderId, productId])')
    assertNoDuplicateModels(generatePrismaSchema(spec))
  })

  it('creates the join model from scratch when through names no resource', () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'tags',
      resources: [
        {
          name: 'Article',
          fields: { title: { type: 'string', required: true } },
          relations: [{ type: 'manyToMany', resource: 'Tag', through: 'article_tags' }],
        },
        { name: 'Tag', fields: { label: { type: 'string', required: true } } },
      ],
    }
    const schema = generatePrismaSchema(spec)
    expect(countModel(schema, 'ArticleTags')).toBe(1)
    const block = modelBlock(schema, 'ArticleTags')
    expect(block).toMatch(/articleId\s+String/)
    expect(block).toMatch(/tagId\s+String/)
    expect(block).toContain('@@id([articleId, tagId])')
    // both endpoints carry a back-relation array
    expect(modelBlock(schema, 'Article')).toMatch(/ArticleTags\[\]/)
    expect(modelBlock(schema, 'Tag')).toMatch(/ArticleTags\[\]/)
    assertNoDuplicateModels(schema)
  })

  it('preserves join-table extra fields when creating from scratch', () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'tags-extra',
      resources: [
        {
          name: 'Article',
          fields: { title: { type: 'string', required: true } },
          relations: [
            {
              type: 'manyToMany',
              resource: 'Tag',
              through: 'article_tags',
              fields: { position: { type: 'integer' } },
            },
          ],
        },
        { name: 'Tag', fields: { label: { type: 'string', required: true } } },
      ],
    }
    const block = modelBlock(generatePrismaSchema(spec), 'ArticleTags')
    expect(block).toMatch(/position\s+Int/)
  })
})
