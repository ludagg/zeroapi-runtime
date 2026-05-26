import { describe, it, expect } from 'vitest'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const relationsSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'relations-test',
  resources: [
    {
      name: 'User',
      fields: { name: { type: 'string', required: true } },
    },
    {
      name: 'Order',
      fields: { total: { type: 'number', required: true } },
      relations: [
        { type: 'manyToOne', resource: 'User', field: 'userId', required: true, onDelete: 'Cascade' },
      ],
    },
    {
      name: 'Product',
      fields: { name: { type: 'string', required: true }, price: { type: 'number', required: true } },
    },
    {
      name: 'Tag',
      fields: { label: { type: 'string', required: true } },
    },
    {
      name: 'ProductWithTags',
      fields: { title: { type: 'string', required: true } },
      relations: [
        {
          type: 'manyToMany',
          resource: 'Tag',
          through: 'product_tags',
          fields: { order: { type: 'integer' } },
        },
      ],
    },
  ],
}

describe('generatePrismaSchema with relations', () => {
  it('generates FK field for manyToOne', () => {
    const schema = generatePrismaSchema(relationsSpec)
    expect(schema).toContain('userId')
  })

  it('generates @relation for manyToOne', () => {
    const schema = generatePrismaSchema(relationsSpec)
    expect(schema).toContain('@relation(fields: [userId]')
  })

  it('generates onDelete Cascade', () => {
    const schema = generatePrismaSchema(relationsSpec)
    expect(schema).toContain('onDelete: Cascade')
  })

  it('generates reverse array field on related model (User.orders)', () => {
    const schema = generatePrismaSchema(relationsSpec)
    expect(schema).toMatch(/orders\s+Order\[\]/)
  })

  it('generates join model for manyToMany', () => {
    const schema = generatePrismaSchema(relationsSpec)
    expect(schema).toContain('model ProductTags {')
  })

  it('join model has composite @@id', () => {
    const schema = generatePrismaSchema(relationsSpec)
    expect(schema).toContain('@@id([')
  })

  it('join model includes extra fields', () => {
    const schema = generatePrismaSchema(relationsSpec)
    expect(schema).toContain('order')
  })

  it('file fields map to String in Prisma', () => {
    const specWithFile: ZeroAPISpec = {
      version: '1.0', name: 'file-spec',
      resources: [{
        name: 'Doc',
        fields: { attachment: { type: 'file', required: false } },
      }],
    }
    const schema = generatePrismaSchema(specWithFile)
    expect(schema).toContain('attachment')
    expect(schema).toContain('String')
  })
})
