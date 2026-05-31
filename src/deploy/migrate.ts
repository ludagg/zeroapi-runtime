import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ZeroAPISpec } from '../types/spec.js'
import { generatePrismaSchema } from '../generators/schema.js'

/**
 * SAFETY MODEL
 * ------------
 * Nothing here runs automatically — `createRuntime` never touches a database.
 * These helpers are opt-in and explicit. `db push` (dev/prototype) is guarded so
 * it cannot run in production or drop data unless the caller opts in, and
 * `migrate deploy` (production) only applies committed migrations and is never
 * destructive. The command runner is injectable so the guardrails are testable
 * without a real database or the Prisma CLI.
 */

/** Result of `spawnSync`-style execution; structurally compatible. */
export interface CommandRunResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Injectable command runner (defaults to `spawnSync`). */
export type SchemaCommandRunner = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
) => CommandRunResult

export interface ApplySchemaResult {
  /** True when the command ran AND exited 0. */
  ok: boolean
  /** True when the database command was actually invoked (false when skipped by a guardrail). */
  applied: boolean
  /** Why the operation was skipped or failed (set when `ok` is false). */
  reason?: string
  /** The schema file written (push mode). */
  schemaPath?: string
  /** The command line that ran (or would have run). */
  command?: string
  stdout?: string
  stderr?: string
}

const defaultRunner: SchemaCommandRunner = (bin, args, options) => {
  const r = spawnSync(bin, args, { env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}), encoding: 'utf8' })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
  }
}

/**
 * Writes the generated Prisma schema to `outputPath` (creating parent dirs).
 * Pure file I/O — the safe prerequisite for any Prisma command. Returns the
 * absolute path written.
 */
export function writePrismaSchema(spec: ZeroAPISpec, outputPath: string): string {
  const abs = resolve(outputPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, generatePrismaSchema(spec))
  return abs
}

interface CommonOptions {
  databaseUrl?: string
  /** Path to the Prisma CLI binary. Defaults to the locally-installed one, then `prisma` on PATH. */
  prismaBin?: string
  /** Base environment for the child process. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Injectable runner (tests). Defaults to `spawnSync`. */
  run?: SchemaCommandRunner
  log?: (line: string) => void
}

export interface PushSchemaOptions extends CommonOptions {
  spec: ZeroAPISpec
  /** Where to write the schema before pushing. Defaults to an OS temp file. */
  schemaPath?: string
  /** Allow Prisma to apply DESTRUCTIVE changes (`--accept-data-loss`). Default false. */
  acceptDataLoss?: boolean
  /** Allow running in `NODE_ENV=production` (db push is risky there). Default false. */
  allowProduction?: boolean
}

export interface DeployMigrationsOptions extends CommonOptions {
  /** Path to the schema whose `migrations/` folder holds the committed migrations. */
  schemaPath: string
}

function resolveDatabaseUrl(opts: CommonOptions): string | undefined {
  return opts.databaseUrl ?? opts.env?.['DATABASE_URL'] ?? process.env['DATABASE_URL']
}

function resolvePrismaBin(opts: CommonOptions): string {
  if (opts.prismaBin) return opts.prismaBin
  // Prefer the locally-installed CLI; fall back to PATH.
  return resolve(process.cwd(), 'node_modules', '.bin', 'prisma')
}

/**
 * DEV / prototype: write the generated schema and run `prisma db push` to sync
 * the database to it (creating tables). Opt-in and guarded:
 *   - no `DATABASE_URL` → skipped (never errors)
 *   - `NODE_ENV=production` without `allowProduction:true` → skipped (db push is
 *     destructive-capable; production should use committed migrations)
 *   - never passes `--accept-data-loss` unless `acceptDataLoss:true`, so Prisma
 *     refuses (and reports) destructive changes by default.
 */
export async function pushPrismaSchema(opts: PushSchemaOptions): Promise<ApplySchemaResult> {
  const log = opts.log ?? ((l: string) => console.warn(l))
  const databaseUrl = resolveDatabaseUrl(opts)
  if (!databaseUrl) {
    return { ok: false, applied: false, reason: 'No DATABASE_URL — cannot apply schema (skipped).' }
  }
  if (process.env['NODE_ENV'] === 'production' && !opts.allowProduction) {
    const reason =
      'Refusing `prisma db push` in production (it can drop data). Use committed ' +
      'migrations with `deployPrismaMigrations()` / `prisma migrate deploy`, or pass ' +
      '`allowProduction: true` to override.'
    log(`⚠️  ZeroAPI — ${reason}`)
    return { ok: false, applied: false, reason }
  }

  const schemaPath = writePrismaSchema(
    opts.spec,
    opts.schemaPath ?? resolve(tmpdir(), `zeroapi-${Date.now()}.prisma`),
  )
  const args = ['db', 'push', `--schema=${schemaPath}`, '--skip-generate']
  if (opts.acceptDataLoss) args.push('--accept-data-loss')

  const bin = resolvePrismaBin(opts)
  const run = opts.run ?? defaultRunner
  const result = run(bin, args, { env: { ...(opts.env ?? process.env), DATABASE_URL: databaseUrl } })
  const command = `${bin} ${args.join(' ')}`

  return {
    ok: result.status === 0,
    applied: true,
    schemaPath,
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.status === 0 ? {} : { reason: `prisma db push exited with status ${result.status}` }),
  }
}

/**
 * PRODUCTION: run `prisma migrate deploy`, which applies only the migrations
 * already committed under the schema's `migrations/` folder. It never creates or
 * drops anything on its own and is non-destructive by construction — the safe
 * way to evolve a production database. Opt-in; skipped without `DATABASE_URL`.
 */
export async function deployPrismaMigrations(opts: DeployMigrationsOptions): Promise<ApplySchemaResult> {
  const databaseUrl = resolveDatabaseUrl(opts)
  if (!databaseUrl) {
    return { ok: false, applied: false, reason: 'No DATABASE_URL — cannot deploy migrations (skipped).' }
  }
  const args = ['migrate', 'deploy', `--schema=${resolve(opts.schemaPath)}`]
  const bin = resolvePrismaBin(opts)
  const run = opts.run ?? defaultRunner
  const result = run(bin, args, { env: { ...(opts.env ?? process.env), DATABASE_URL: databaseUrl } })
  const command = `${bin} ${args.join(' ')}`

  return {
    ok: result.status === 0,
    applied: true,
    schemaPath: resolve(opts.schemaPath),
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.status === 0 ? {} : { reason: `prisma migrate deploy exited with status ${result.status}` }),
  }
}
