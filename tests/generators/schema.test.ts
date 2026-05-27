import { describe, it, expect } from 'vitest'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import { sampleSpec, minimalSpec } from '../fixtures/sample-spec.js'

describe('generatePrismaSchema', () => {
  it('includes datasource and generator blocks', () => {
    const schema = generatePrismaSchema(minimalSpec)
    expect(schema).toContain('datasource db')
    expect(schema).toContain('generator client')
    expect(schema).toContain('provider = "prisma-client-js"')
    expect(schema).toContain('provider = "postgresql"')
  })

  it('generates a model per resource', () => {
    const schema = generatePrismaSchema(sampleSpec)
    expect(schema).toContain('model User {')
    expect(schema).toContain('model Post {')
  })

  it('adds standard fields to every model', () => {
    const schema = generatePrismaSchema(minimalSpec)
    expect(schema).toContain('@id @default(cuid())')
    expect(schema).toContain('@default(now())')
    expect(schema).toContain('@updatedAt')
  })

  it('marks unique fields with @unique', () => {
    const schema = generatePrismaSchema(sampleSpec)
    expect(schema).toContain('@unique')
  })

  it('marks optional fields with ?', () => {
    const schema = generatePrismaSchema(sampleSpec)
    // age is not required
    expect(schema).toMatch(/age\s+Int\?/)
  })

  it('includes default values', () => {
    const schema = generatePrismaSchema(sampleSpec)
    expect(schema).toContain('@default(false)')
  })

  it('maps all field types to Prisma types', () => {
    const schema = generatePrismaSchema(sampleSpec)
    expect(schema).toContain('String')
    expect(schema).toContain('Boolean')
  })

  it('includes spec name and version in header comment', () => {
    const schema = generatePrismaSchema(sampleSpec)
    expect(schema).toContain('test-api')
    expect(schema).toContain('1.0.0')
  })

  it('does not duplicate reserved fields when declared in the spec', () => {
    const schema = generatePrismaSchema({
      version: '1.0.0',
      name: 'dup-api',
      resources: [
        {
          name: 'Thing',
          fields: {
            id:        { type: 'uuid',     required: true },
            createdAt: { type: 'datetime', required: true },
            updatedAt: { type: 'datetime', required: true },
            label:     { type: 'string',   required: true },
          },
        },
      ],
    })

    const thingBlock = schema.match(/model Thing \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(thingBlock.match(/^\s*id\s/gm)?.length).toBe(1)
    expect(thingBlock.match(/^\s*createdAt\s/gm)?.length).toBe(1)
    expect(thingBlock.match(/^\s*updatedAt\s/gm)?.length).toBe(1)
    expect(thingBlock).toContain('label')
  })

  it('does not re-declare a FK field already owned by a relation', () => {
    const schema = generatePrismaSchema({
      version: '1.0.0',
      name: 'rel-api',
      resources: [
        {
          name: 'User',
          fields: { email: { type: 'email', required: true, unique: true } },
        },
        {
          name: 'Post',
          fields: {
            title:  { type: 'string', required: true },
            userId: { type: 'uuid',   required: true },
          },
          relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: true }],
        },
      ],
    })

    const postBlock = schema.match(/model Post \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(postBlock.match(/^\s*userId\s/gm)?.length).toBe(1)
  })
})
