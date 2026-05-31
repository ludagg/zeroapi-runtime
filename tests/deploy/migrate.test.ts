import { describe, it, expect } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  writePrismaSchema, pushPrismaSchema, deployPrismaMigrations,
  parseSpec, type SchemaCommandRunner, type CommandRunResult,
} from '../../src/index.js'

const spec = parseSpec({
  version: '1.0.0',
  name: 'migrate-test',
  resources: [{ name: 'Widget', fields: { label: { type: 'string', required: true } } }],
})

/** A fake runner that records the last invocation and never touches a DB. */
function recordingRunner(status = 0): { run: SchemaCommandRunner; calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const run: SchemaCommandRunner = (bin, args, options): CommandRunResult => {
    calls.push({ bin, args, env: options.env })
    return { status, stdout: 'fake ok', stderr: '' }
  }
  return { run, calls }
}

/** Run `fn` with a temporary NODE_ENV, restoring it afterwards. */
async function withNodeEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env['NODE_ENV']
  if (value === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = value
  try { await fn() } finally {
    if (saved === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = saved
  }
}

describe('writePrismaSchema', () => {
  it('writes the generated schema to disk', () => {
    const out = resolve(tmpdir(), `zeroapi-write-${Date.now()}.prisma`)
    try {
      const written = writePrismaSchema(spec, out)
      const content = readFileSync(written, 'utf8')
      expect(content).toContain('model Widget {')
      expect(content).toContain('datasource db {')
    } finally {
      rmSync(out, { force: true })
    }
  })
})

describe('pushPrismaSchema — guardrails', () => {
  it('skips (no error) when no DATABASE_URL is available', async () => {
    await withNodeEnv('test', async () => {
      const { run, calls } = recordingRunner()
      const res = await pushPrismaSchema({ spec, env: {}, run, databaseUrl: undefined })
      expect(res.applied).toBe(false)
      expect(res.ok).toBe(false)
      expect(res.reason).toMatch(/DATABASE_URL/)
      expect(calls).toHaveLength(0) // never invoked the CLI
    })
  })

  it('refuses to run in production without allowProduction', async () => {
    await withNodeEnv('production', async () => {
      const { run, calls } = recordingRunner()
      const res = await pushPrismaSchema({ spec, databaseUrl: 'postgresql://x', run, log: () => {} })
      expect(res.applied).toBe(false)
      expect(res.reason).toMatch(/production/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('runs in production when allowProduction is explicitly set', async () => {
    await withNodeEnv('production', async () => {
      const { run, calls } = recordingRunner()
      const res = await pushPrismaSchema({ spec, databaseUrl: 'postgresql://x', allowProduction: true, run })
      expect(res.applied).toBe(true)
      expect(calls).toHaveLength(1)
    })
  })

  it('runs db push and does NOT pass --accept-data-loss by default', async () => {
    await withNodeEnv('test', async () => {
      const { run, calls } = recordingRunner()
      const res = await pushPrismaSchema({ spec, databaseUrl: 'postgresql://x', run })
      expect(res.applied).toBe(true)
      expect(res.ok).toBe(true)
      expect(calls[0]?.args).toEqual(expect.arrayContaining(['db', 'push', '--skip-generate']))
      expect(calls[0]?.args).not.toContain('--accept-data-loss')
      // DATABASE_URL is forwarded to the child env.
      expect(calls[0]?.env['DATABASE_URL']).toBe('postgresql://x')
    })
  })

  it('passes --accept-data-loss ONLY when acceptDataLoss is true', async () => {
    await withNodeEnv('test', async () => {
      const { run, calls } = recordingRunner()
      await pushPrismaSchema({ spec, databaseUrl: 'postgresql://x', acceptDataLoss: true, run })
      expect(calls[0]?.args).toContain('--accept-data-loss')
    })
  })

  it('reports a non-zero exit as not ok (but applied)', async () => {
    await withNodeEnv('test', async () => {
      const { run } = recordingRunner(1)
      const res = await pushPrismaSchema({ spec, databaseUrl: 'postgresql://x', run })
      expect(res.applied).toBe(true)
      expect(res.ok).toBe(false)
      expect(res.reason).toMatch(/status 1/)
    })
  })
})

describe('deployPrismaMigrations', () => {
  it('skips without DATABASE_URL', async () => {
    const { run, calls } = recordingRunner()
    const res = await deployPrismaMigrations({ schemaPath: 'prisma/schema.prisma', env: {}, databaseUrl: undefined, run })
    expect(res.applied).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('runs `migrate deploy` (non-destructive prod path)', async () => {
    const { run, calls } = recordingRunner()
    const res = await deployPrismaMigrations({ schemaPath: 'prisma/schema.prisma', databaseUrl: 'postgresql://x', run })
    expect(res.applied).toBe(true)
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['migrate', 'deploy']))
    // never destructive flags
    expect(calls[0]?.args).not.toContain('--accept-data-loss')
  })
})
