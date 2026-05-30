import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import { parseSpec, ParseError } from '../../src/parser/index.js'

/** Runs the real `prisma validate` CLI against a schema (offline WASM). */
function prismaValidate(schema: string): string {
  const prismaBin = resolve(process.cwd(), 'node_modules/.bin/prisma')
  const dir = mkdtempSync(join(tmpdir(), 'zeroapi-prisma-'))
  const schemaPath = join(dir, 'schema.prisma')
  writeFileSync(schemaPath, schema)
  return execFileSync(prismaBin, ['validate', `--schema=${schemaPath}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: 'postgresql://u:p@localhost:5432/db' },
  })
}

const prismaInstalled = existsSync(resolve(process.cwd(), 'node_modules/.bin/prisma'))
const itIfPrisma = prismaInstalled ? it : it.skip

// ─────────────────────────────────────────────────────────────────────────────
// Self many-to-many (e.g. "User follows User" via a Follows join table).
// Stress-test hole: this produced an INVALID schema — duplicated `xId` columns,
// duplicated relation fields and `@@id([xId, xId])` (Prisma P1012).
// ─────────────────────────────────────────────────────────────────────────────

describe('self many-to-many schema generation', () => {
  const spec = parseSpec({
    version: '1.0.0',
    name: 'social',
    resources: [
      {
        name: 'Person',
        fields: { handle: { type: 'string', required: true } },
        relations: [{ type: 'manyToMany', resource: 'Person', through: 'Follows' }],
      },
    ],
  })

  it('emits a join model with two DISTINCT fk columns and relation fields', () => {
    const schema = generatePrismaSchema(spec)
    const followsBlock = schema.slice(schema.indexOf('model Follows'))
      .slice(0, schema.slice(schema.indexOf('model Follows')).indexOf('}') + 1)

    // Two distinct FK columns — not `personId` twice.
    expect(followsBlock).toContain('personId')
    expect(followsBlock).toContain('relatedPersonId')
    // No duplicated column / no self-referential composite id.
    expect(followsBlock).not.toContain('@@id([personId, personId])')
    expect(followsBlock).toContain('@@id([personId, relatedPersonId])')
    // Paired @relation names on both endpoints.
    expect(followsBlock).toContain('@relation("Follows_person"')
    expect(followsBlock).toContain('@relation("Follows_relatedPerson"')
  })

  it('the self model carries two distinct, named back-relation arrays', () => {
    const schema = generatePrismaSchema(spec)
    const personBlock = schema.slice(schema.indexOf('model Person'))
    expect(personBlock).toContain('Follows[] @relation("Follows_person")')
    expect(personBlock).toContain('Follows[] @relation("Follows_relatedPerson")')
  })

  itIfPrisma('passes the real `prisma validate`', () => {
    const out = prismaValidate(generatePrismaSchema(spec))
    expect(out).toMatch(/is valid/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pure association entity: a first-class join resource that carries no scalar
// payload of its own (fields: {}), only relations. Stress-test hole: rejected
// by the parser ("must define at least one field").
// ─────────────────────────────────────────────────────────────────────────────

describe('pure association entity (empty fields + relations)', () => {
  const makeSpec = () =>
    parseSpec({
      version: '1.0.0',
      name: 'school',
      resources: [
        {
          name: 'Student',
          fields: { name: { type: 'string', required: true } },
          relations: [{ type: 'manyToMany', resource: 'Course', through: 'Enrollment' }],
        },
        { name: 'Course', fields: { title: { type: 'string', required: true } } },
        {
          name: 'Enrollment',
          fields: {},
          relations: [
            { type: 'manyToOne', resource: 'Student', field: 'studentId' },
            { type: 'manyToOne', resource: 'Course', field: 'courseId' },
          ],
        },
      ],
    })

  it('is accepted by the parser', () => {
    const spec = makeSpec()
    const enrollment = spec.resources.find((r) => r.name === 'Enrollment')
    expect(enrollment).toBeDefined()
    expect(Object.keys(enrollment!.fields)).toHaveLength(0)
    expect(enrollment!.relations).toHaveLength(2)
  })

  it('still rejects a resource with neither fields nor relations', () => {
    expect(() =>
      parseSpec({
        version: '1.0.0',
        name: 'bad',
        resources: [{ name: 'Empty', fields: {} }],
      }),
    ).toThrow(ParseError)
  })

  itIfPrisma('generates a schema that passes `prisma validate`', () => {
    const out = prismaValidate(generatePrismaSchema(makeSpec()))
    expect(out).toMatch(/is valid/i)
  })
})
