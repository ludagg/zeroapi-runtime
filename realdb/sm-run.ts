/* Real-PostgreSQL verification of declarative state machines. */
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { generateAccessToken } from '../src/auth/jwt.js'
import { spec } from './sm-spec.js'

const SECRET = 'realdb-sm-secret'
process.env['JWT_SECRET'] = SECRET
const results: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}
const token = (role: string) => generateAccessToken(`${role}-1`, `${role}@x.com`, role, SECRET, 3600)

async function main() {
  const prisma = new PrismaClient()
  await prisma.$connect()
  await prisma.$executeRawUnsafe('DELETE FROM "Post"')
  const app = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never }).app

  const create = async (role: string, body: Record<string, unknown>) =>
    app.request('/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(role)}` }, body: JSON.stringify(body) })
  const put = async (role: string, id: string, body: Record<string, unknown>) =>
    app.request(`/posts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(role)}` }, body: JSON.stringify(body) })
  const j = (r: Response) => r.json() as any

  // create forces initial
  const c = await j(await create('editor', { title: 'P', status: 'published' }))
  const id = c.data.id
  check('create forces status=initial (draft) despite body', c.data.status === 'draft', `status=${c.data.status}`)
  // confirm in DB
  const dbRow = await prisma.post.findUnique({ where: { id } })
  check('DB row persisted with status=draft', dbRow?.status === 'draft', `db status=${dbRow?.status}`)

  // valid transition + role
  const r1 = await put('editor', id, { status: 'published' })
  check('editor draft→published → 200', r1.status === 200, `status=${r1.status}`)

  // wrong role on a listed transition
  const r2 = await put('editor', id, { status: 'archived' })
  check('editor published→archived → 403 (admin-only)', r2.status === 403, `status=${r2.status}`)

  // unlisted transition
  const c2 = await j(await create('admin', { title: 'Q' }))
  const r3 = await put('admin', c2.data.id, { status: 'archived' })
  check('admin draft→archived (unlisted) → 409', r3.status === 409, `status=${r3.status}`)

  // admin-only transition succeeds
  const r4 = await put('admin', id, { status: 'archived' })
  check('admin published→archived → 200', r4.status === 200, `status=${(await j(r4)).data?.status}`)

  // update not touching status
  const r5 = await put('editor', c2.data.id, { title: 'renamed' })
  const b5 = await j(r5)
  check('update without status is unconstrained', r5.status === 200 && b5.data.title === 'renamed' && b5.data.status === 'draft', `status=${r5.status} title=${b5.data?.title} state=${b5.data?.status}`)

  await prisma.$disconnect()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== ${passed}/${results.length} state-machine scenarios passed on real PostgreSQL ===`)
  process.exit(passed === results.length ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(2) })
