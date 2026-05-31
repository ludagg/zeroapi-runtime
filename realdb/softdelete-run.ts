/* Proof of soft-delete in BOTH memory and Prisma mode.
 *   DELETE marks a deletedAt tombstone (row kept); list/read hide it by default;
 *   ?includeDeleted=true reveals it. Run with DATABASE_URL set, after db push +
 *   generate on realdb/prisma/softdelete.prisma. */
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { spec } from './softdelete-spec.js'

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}
const json = (r: Response) => r.json() as Promise<any>
type App = ReturnType<typeof createRuntime>['app']

async function post(app: App, path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function exercise(label: string, app: App, prisma?: PrismaClient) {
  // create
  const created = await json(await post(app, '/notes', { title: 'keep-or-tombstone' }))
  const id = created.data.id

  // visible before delete
  const before = await json(await app.request('/notes'))
  check(`${label}: note visible before delete (count=1)`, before.count === 1 && before.data.length === 1, `count=${before.count}`)

  // soft delete
  const del = await app.request(`/notes/${id}`, { method: 'DELETE' })
  check(`${label}: DELETE returns 200`, del.status === 200, `status=${del.status}`)

  // hidden in list
  const afterList = await json(await app.request('/notes'))
  check(`${label}: list HIDES soft-deleted row (count=0)`, afterList.count === 0 && afterList.data.length === 0, `count=${afterList.count}`)

  // 404 on read
  const read = await app.request(`/notes/${id}`)
  check(`${label}: read soft-deleted row → 404`, read.status === 404, `status=${read.status}`)

  // 404 on update
  const upd = await app.request(`/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })
  check(`${label}: update soft-deleted row → 404`, upd.status === 404, `status=${upd.status}`)

  // visible again with includeDeleted
  const incList = await json(await app.request('/notes?includeDeleted=true'))
  check(`${label}: ?includeDeleted=true REVEALS the row (count=1)`, incList.count === 1 && incList.data[0]?.deletedAt != null, `count=${incList.count} deletedAt=${incList.data[0]?.deletedAt ? 'set' : 'null'}`)

  const incRead = await app.request(`/notes/${id}?includeDeleted=true`)
  check(`${label}: read with ?includeDeleted=true → 200`, incRead.status === 200, `status=${incRead.status}`)

  // Prisma only: the row physically SURVIVES in the DB with deletedAt set.
  if (prisma) {
    const inDb = await prisma.note.findUnique({ where: { id } })
    check(`${label}: row still PHYSICALLY in Postgres (soft, not hard delete)`,
      !!inDb && inDb.deletedAt != null, `present=${!!inDb} deletedAt=${inDb?.deletedAt ? 'set' : 'null'}`)
  }
}

async function main() {
  // ── MEMORY MODE ──
  const memApp = createRuntime(spec, { enableLogging: false }).app
  await exercise('memory', memApp)

  // ── PRISMA MODE (real Postgres) ──
  const prisma = new PrismaClient()
  await prisma.$connect()
  await prisma.$executeRawUnsafe(`DELETE FROM "Note"`)
  const dbApp = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never }).app
  await exercise('prisma', dbApp, prisma)
  await prisma.$disconnect()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
