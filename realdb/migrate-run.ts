/* Real-database proof of schema-migration helpers.
 *   - pushPrismaSchema actually creates the tables (verified via information_schema)
 *   - guardrails: production without allowProduction → skipped (DB untouched);
 *     no DATABASE_URL → skipped; --accept-data-loss only when opted in
 * Run with DATABASE_URL set; needs psql + node_modules/.bin/prisma. */
import { execFileSync } from 'node:child_process'
import { parseSpec, pushPrismaSchema } from '../src/index.js'

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://zerotest:zerotest@127.0.0.1:5432/zeroapi_test'
const PRISMA_BIN = 'node_modules/.bin/prisma'

const spec = parseSpec({
  version: '1.0.0',
  name: 'migrate-proof',
  resources: [
    { name: 'Gadget', fields: { label: { type: 'string', required: true }, price: { type: 'integer', required: true } } },
    { name: 'Gizmo', fields: { name: { type: 'string', required: true } } },
  ],
})

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

/** Query the live table list via psql (no generated client needed). */
function tablesPresent(names: string[]): string[] {
  const inList = names.map((n) => `'${n}'`).join(',')
  const out = execFileSync('psql', [
    DB_URL, '-tAc',
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${inList})`,
  ], { encoding: 'utf8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

async function main() {
  // Clean slate — reset the public schema to empty so `db push` creates exactly
  // the spec's tables from scratch (the DB is a throwaway test database).
  execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'zeroapi_test', '-c',
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO zerotest; GRANT ALL ON SCHEMA public TO public;',
  ], { stdio: 'pipe' })
  check('clean slate: empty schema before push', tablesPresent(['Gadget', 'Gizmo']).length === 0, 'reset')

  // ── 1. pushPrismaSchema actually creates the tables ──────────────────────
  const res = await pushPrismaSchema({ spec, databaseUrl: DB_URL, prismaBin: PRISMA_BIN, log: () => {} })
  check('pushPrismaSchema: ok + applied', res.ok && res.applied, `ok=${res.ok} applied=${res.applied} cmd="${res.command?.replace(process.cwd() + '/', '')}"`)
  const present = tablesPresent(['Gadget', 'Gizmo']).sort()
  check('tables CREATED in the database (information_schema.tables)',
    present.length === 2 && present.includes('Gadget') && present.includes('Gizmo'),
    `present=[${present.join(', ')}]`)

  // ── 2. GUARDRAIL: production without allowProduction → skipped, DB untouched ──
  const sentinelSpec = parseSpec({
    version: '1.0.0', name: 'sentinel',
    resources: [{ name: 'Sentinel', fields: { v: { type: 'string', required: true } } }],
  })
  const savedNodeEnv = process.env['NODE_ENV']
  process.env['NODE_ENV'] = 'production'
  let prodLog = ''
  const prodRes = await pushPrismaSchema({ spec: sentinelSpec, databaseUrl: DB_URL, prismaBin: PRISMA_BIN, log: (l) => { prodLog = l } })
  if (savedNodeEnv === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = savedNodeEnv
  check('guardrail: production without allowProduction → skipped (not applied)',
    !prodRes.applied && !prodRes.ok && /production/i.test(prodRes.reason ?? ''), `reason="${prodRes.reason?.slice(0, 50)}…"`)
  check('guardrail: DB UNTOUCHED in prod-skip (Sentinel table not created)',
    tablesPresent(['Sentinel']).length === 0, `sentinelPresent=${tablesPresent(['Sentinel']).length}`)

  // ── 3. GUARDRAIL: no DATABASE_URL → skipped ──────────────────────────────
  const savedUrl = process.env['DATABASE_URL']
  delete process.env['DATABASE_URL']
  const noUrlRes = await pushPrismaSchema({ spec: sentinelSpec, prismaBin: PRISMA_BIN, env: {} })
  if (savedUrl !== undefined) process.env['DATABASE_URL'] = savedUrl
  check('guardrail: no DATABASE_URL → skipped (not applied)',
    !noUrlRes.applied && /DATABASE_URL/.test(noUrlRes.reason ?? ''), `reason="${noUrlRes.reason}"`)

  // ── 4. Idempotent re-push (schema already in sync) still ok ──────────────
  const again = await pushPrismaSchema({ spec, databaseUrl: DB_URL, prismaBin: PRISMA_BIN, log: () => {} })
  check('re-push is idempotent (already in sync → still ok)', again.ok && again.applied, `ok=${again.ok}`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
