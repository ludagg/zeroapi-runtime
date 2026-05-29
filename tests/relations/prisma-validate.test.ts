import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import { parseSpec } from '../../src/parser/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

/**
 * Runs the real `prisma validate` CLI against a generated schema. The CLI
 * bundles its query-engine WASM, so validation is fully offline — it only
 * needs DATABASE_URL to satisfy the `env(...)` in the datasource block.
 *
 * Returns the validator's combined output; throws (failing the test) when the
 * schema is invalid, surfacing the exact P1012 Prisma would report at deploy.
 */
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
const describeIfPrisma = prismaInstalled ? describe : describe.skip

describeIfPrisma('generated Prisma schema passes `prisma validate`', () => {
  // ── The obligatory real e-commerce spec ──────────────────────────────────
  //   Category 1-N Product
  //   Product  N-N Order  (via OrderItem)
  //   Review   N-1 Product, Review N-1 User
  //   Order    N-1 User
  it('validates the full e-commerce spec without error', () => {
    const spec = parseSpec({
      version: '1.0.0',
      name: 'ecommerce',
      auth: { jwt: { enabled: true } },
      resources: [
        { name: 'Category', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Product',
          fields: {
            name: { type: 'string', required: true },
            price: { type: 'decimal', required: true },
          },
        },
        { name: 'Order', fields: { total: { type: 'decimal', required: true } } },
        {
          name: 'OrderItem',
          fields: {
            quantity: { type: 'integer', required: true },
            priceAtPurchase: { type: 'decimal', required: true },
          },
        },
        { name: 'Review', fields: { rating: { type: 'integer', required: true } } },
      ],
      relations: [
        { from: 'Category', to: 'Product', type: 'one-to-many', field: 'products' },
        { from: 'Product', to: 'Order', type: 'many-to-many', field: 'orders', through: 'OrderItem' },
        { from: 'Review', to: 'Product', type: 'many-to-one', field: 'productId' },
        { from: 'Review', to: 'User', type: 'many-to-one', field: 'userId' },
        { from: 'Order', to: 'User', type: 'many-to-one', field: 'userId' },
      ],
    })

    const schema = generatePrismaSchema(spec)
    const out = prismaValidate(schema)
    expect(out).toMatch(/is valid/)
  })

  // ── Regression: multiple relations to the SAME target model ──────────────
  // buyerId + sellerId both → User. Without disambiguated @relation names this
  // is the P1012 the bug report describes ("Field already defined" / ambiguous
  // back-relation).
  it('validates a model with two relations to the same target (buyer/seller → User)', () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'marketplace',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Order',
          fields: { total: { type: 'decimal', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'buyerId' },
            { type: 'manyToOne', resource: 'User', field: 'sellerId' },
          ],
        },
      ],
    }

    const schema = generatePrismaSchema(spec)
    const out = prismaValidate(schema)
    expect(out).toMatch(/is valid/)
  })

  it('validates two relations between two user-defined models (sender/receiver → Person)', () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'chat',
      resources: [
        { name: 'Person', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Message',
          fields: { body: { type: 'string', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Person', field: 'senderId', required: true },
            { type: 'manyToOne', resource: 'Person', field: 'receiverId', required: true },
          ],
        },
      ],
    }

    const schema = generatePrismaSchema(spec)
    const out = prismaValidate(schema)
    expect(out).toMatch(/is valid/)
  })
})
