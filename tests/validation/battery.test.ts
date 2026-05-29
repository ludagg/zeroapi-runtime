import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'
import { parseSpec } from '../../src/parser/index.js'
import { generatePrismaSchema } from '../../src/generators/schema.js'
import { generateOpenAPISpec } from '../../src/docs/swagger.js'
import { generateSdk } from '../../src/sdk/generate.js'
import { batterySpecs } from './battery-specs.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

/**
 * Runs the real `prisma validate` CLI against a generated schema. The CLI
 * bundles its query-engine WASM, so validation is fully offline — it only needs
 * DATABASE_URL to satisfy the `env(...)` in the datasource block. Throws (with
 * the exact P1012 Prisma would report at deploy) when the schema is invalid.
 */
function prismaValidate(schema: string): string {
  const prismaBin = resolve(process.cwd(), 'node_modules/.bin/prisma')
  const dir = mkdtempSync(join(tmpdir(), 'zeroapi-battery-prisma-'))
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

// Pre-parse the whole battery once. Parsing must succeed for every entry —
// these are all valid specs by construction.
const parsed: Array<{ name: string; spec: ZeroAPISpec }> = batterySpecs.map((b) => ({
  name: b.name,
  spec: parseSpec(b.raw),
}))

const cases = parsed.map((p) => [p.name, p.spec] as const)

describe(`schema-validation battery — ${batterySpecs.length} specs`, () => {
  it('every battery spec parses cleanly', () => {
    expect(parsed.length).toBe(batterySpecs.length)
  })

  // ── (a) Prisma ────────────────────────────────────────────────────────────
  describeIfPrisma('generated Prisma schema passes `prisma validate`', () => {
    it.each(cases)('[%s] is a valid Prisma schema', (_name, spec) => {
      const schema = generatePrismaSchema(spec)
      let out = ''
      try {
        out = prismaValidate(schema)
      } catch (err: unknown) {
        const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
        const detail = String(e.stdout ?? '') + String(e.stderr ?? '')
        throw new Error(`prisma validate failed:\n${detail}\n\n--- schema ---\n${schema}`)
      }
      expect(out).toMatch(/is valid/)
    })
  })

  // ── (b) OpenAPI ───────────────────────────────────────────────────────────
  describe('generated OpenAPI doc is a valid OpenAPI 3.0 spec', () => {
    it.each(cases)('[%s] validates with swagger-parser', async (_name, spec) => {
      const openapi = generateOpenAPISpec(spec)
      // Clone to a plain object — SwaggerParser mutates/dereferences in place.
      const doc = JSON.parse(JSON.stringify(openapi))
      await expect(SwaggerParser.validate(doc)).resolves.toBeDefined()
    })
  })
})

// ── (c) SDK — every battery SDK compiles under `tsc --strict` (one pass) ───────

describe('schema-validation battery — generated SDKs compile with tsc --strict', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zeroapi-battery-sdk-'))
    for (const { name, spec } of parsed) {
      writeFileSync(join(tmpDir, `${name}.ts`), generateSdk(spec), 'utf8')
    }
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('all SDKs type-check under --strict', () => {
    let ok = true
    let output = ''
    try {
      execSync(
        `npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022,DOM --skipLibCheck ${tmpDir}/*.ts`,
        { encoding: 'utf8', stdio: 'pipe' },
      )
    } catch (err: unknown) {
      ok = false
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
      output = String(e.stdout ?? '') + String(e.stderr ?? '')
    }
    if (!ok) console.error(output)
    expect(ok).toBe(true)
  }, 120_000)
})
