import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import { sampleSpec, minimalSpec } from '../fixtures/sample-spec.js'

/**
 * Runs `prisma validate` over a generated schema and returns the combined
 * output. Throws (failing the test) when validation fails. SQLite is forced as
 * the datasource provider so validation needs no external DATABASE_URL.
 */
function prismaValidate(schema: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zeroapi-prisma-'))
  try {
    const sqliteSchema = schema
      .replace('provider = "postgresql"', 'provider = "sqlite"')
      .replace('env("DATABASE_URL")', '"file:./dev.db"')
    const schemaPath = join(dir, 'schema.prisma')
    writeFileSync(schemaPath, sqliteSchema)
    return execFileSync('npx', ['prisma', 'validate', '--schema', schemaPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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

  it('renders long field names with a space before the Prisma type', () => {
    // Regression for the "priceAtPurchaseDecimal" bug: padEnd(14) used to
    // glue the name to the type when the name was ≥ 14 chars.
    const schema = generatePrismaSchema({
      version: '1.0.0',
      name: 'long-name-api',
      resources: [
        {
          name: 'OrderItem',
          fields: {
            priceAtPurchase: { type: 'decimal', required: true },
          },
        },
      ],
    })

    const block = schema.match(/model OrderItem \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).not.toMatch(/priceAtPurchaseDecimal/)
    expect(block).toMatch(/^\s{2}priceAtPurchase\s+Decimal\s*$/m)
  })

  it('maps every supported field type to a syntactically valid Prisma line', () => {
    const schema = generatePrismaSchema({
      version: '1.0.0',
      name: 'all-types-api',
      resources: [
        {
          name: 'AllTypes',
          fields: {
            // Short and long names to exercise both padding branches.
            str:                  { type: 'string',   required: true },
            txt:                  { type: 'text',     required: true },
            mail:                 { type: 'email',    required: true },
            link:                 { type: 'url',      required: true },
            uid:                  { type: 'uuid',     required: true },
            num:                  { type: 'number',   required: true },
            count:                { type: 'integer',  required: true },
            priceAtPurchase:      { type: 'decimal',  required: true },
            isPublished:          { type: 'boolean',  required: true },
            birthday:             { type: 'date',     required: true },
            scheduledAtTimestamp: { type: 'datetime', required: true },
            avatar:               { type: 'file',     required: true },
            attachments:          { type: 'file[]',   required: true },
            metadataPayload:      { type: 'json',     required: true },
            status:               { type: 'enum',     required: true, values: ['a', 'b'] },
          },
        },
      ],
    })

    const block = schema.match(/model AllTypes \{[\s\S]*?\n\}/)?.[0] ?? ''
    const expectations: Array<[string, string]> = [
      ['str',                  'String'],
      ['txt',                  'String'],
      ['mail',                 'String'],
      ['link',                 'String'],
      ['uid',                  'String'],
      ['num',                  'Float'],
      ['count',                'Int'],
      ['priceAtPurchase',      'Decimal'],
      ['isPublished',          'Boolean'],
      ['birthday',             'DateTime'],
      ['scheduledAtTimestamp', 'DateTime'],
      ['avatar',               'String'],
      ['attachments',          'String'],
      ['metadataPayload',      'Json'],
      ['status',               'String'],
    ]
    for (const [fieldName, prismaType] of expectations) {
      // Each field line must have the shape "  <name>  <Type>" — name and type
      // separated by at least one whitespace, never concatenated.
      const re = new RegExp(`^  ${fieldName}\\s+${prismaType}\\b`, 'm')
      expect(block, `expected "${fieldName} ${prismaType}" line`).toMatch(re)
    }

    // Sanity: no line should ever start with "  <name><Type>" (no glue).
    const bodyLines = block.split('\n').slice(1, -1)
    for (const line of bodyLines) {
      expect(line, `field line should not glue name and type: ${line}`)
        .toMatch(/^\s{2}\w+\s+[A-Z]\w*(\[\])?\??/)
    }
  })

  it('emits @default(now()) as a function for datetime "now" defaults, not a string', () => {
    // Regression: a datetime field with default "now" used to render
    // @default("now"), which Prisma rejects with
    // "'now' is not a valid rfc3339 datetime string".
    const schema = generatePrismaSchema({
      version: '1.0.0',
      name: 'now-default-api',
      resources: [
        {
          name: 'Membership',
          fields: {
            enrollmentDate: { type: 'datetime', required: true, default: 'now' },
            issueDate:      { type: 'date',     required: true, default: 'now' },
            // Call-form should also normalise to the bare function.
            startedAt:      { type: 'datetime', required: true, default: 'now()' },
          },
        },
      ],
    })

    const block = schema.match(/model Membership \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toContain('@default(now())')
    expect(block).not.toContain('@default("now")')
    expect(block).not.toContain('@default("now()")')
    // The three custom date fields render the function form (the 4th match is
    // the model's auto-generated `createdAt @default(now())`).
    expect(block.match(/@default\(now\(\)\)/g)?.length).toBe(4)
    expect(block).toMatch(/enrollmentDate\s+DateTime\s+@default\(now\(\)\)/)
    expect(block).toMatch(/issueDate\s+DateTime\s+@default\(now\(\)\)/)
    expect(block).toMatch(/startedAt\s+DateTime\s+@default\(now\(\)\)/)
  })

  it('emits uuid()/cuid() as functions, not strings', () => {
    const schema = generatePrismaSchema({
      version: '1.0.0',
      name: 'fn-default-api',
      resources: [
        {
          name: 'Token',
          fields: {
            publicId: { type: 'uuid',   required: true, default: 'uuid' },
            slug:     { type: 'string', required: true, default: 'cuid' },
          },
        },
      ],
    })

    const block = schema.match(/model Token \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toContain('@default(uuid())')
    expect(block).toContain('@default(cuid())')
    expect(block).not.toContain('@default("uuid")')
    expect(block).not.toContain('@default("cuid")')
  })

  it('keeps genuine string literals quoted (e.g. enum default)', () => {
    const schema = generatePrismaSchema({
      version: '1.0.0',
      name: 'literal-default-api',
      resources: [
        {
          name: 'Ticket',
          fields: {
            status:  { type: 'enum',   required: true, values: ['pending', 'done'], default: 'pending' },
            // A string field literally named "now" is NOT a function for a string.
            label:   { type: 'string', required: true, default: 'now' },
          },
        },
      ],
    })

    const block = schema.match(/model Ticket \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toContain('@default("pending")')
    expect(block).toContain('@default("now")')
  })

  it('produces a schema that passes `prisma validate` for date defaults', () => {
    const schema = generatePrismaSchema({
      version: '1.0.0',
      name: 'date-validate-api',
      resources: [
        {
          name: 'Enrollment',
          fields: {
            enrollmentDate: { type: 'datetime', required: true, default: 'now' },
            issueDate:      { type: 'date',     required: true, default: 'now' },
            date:           { type: 'datetime', required: false, default: 'now' },
            status:         { type: 'enum', required: true, values: ['active'], default: 'active' },
          },
        },
      ],
    })

    const output = prismaValidate(schema)
    expect(output).toMatch(/valid/i)
  }, 60_000)

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
