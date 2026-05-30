/* Real-PostgreSQL verification of multi-tenant RBAC scope (column/claim). */
import { PrismaClient } from '@prisma/client'
import { sign } from 'hono/jwt'
import { createRuntime } from '../src/index.js'
import { spec } from './scope-spec.js'

const SECRET = 'realdb-scope-secret'
process.env['JWT_SECRET'] = SECRET
const results: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}
const token = (sub: string, org: string) =>
  sign({ sub, role: 'member', org, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET, 'HS256')

async function main() {
  const prisma = new PrismaClient()
  await prisma.$connect()
  await prisma.$executeRawUnsafe('DELETE FROM "Document"')
  const app = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never }).app

  const post = async (title: string, sub: string, org: string, bodyOrg?: string) => {
    const body: Record<string, unknown> = { title }
    if (bodyOrg !== undefined) body['organizationId'] = bodyOrg
    return app.request('/documents', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(sub, org)}` }, body: JSON.stringify(body) })
  }
  const list = async (sub: string, org: string) =>
    (await (await app.request('/documents', { headers: { Authorization: `Bearer ${await token(sub, org)}` } })).json()) as { data: Array<{ title: string; organizationId: string }> }

  // create-force: Alice (org-A) tries to write into org-B via the body
  const created = await (await post('A-secret', 'alice', 'org-A', 'org-B')).json() as { data: { id: string; organizationId: string } }
  check('create forces organizationId to requester org (not body org-B)', created.data.organizationId === 'org-A', `organizationId=${created.data.organizationId}`)

  await post('A2', 'alice', 'org-A')
  await post('B1', 'bob', 'org-B')

  // verify directly in Postgres that rows carry the right tenant
  const dbCountA = await prisma.document.count({ where: { organizationId: 'org-A' } })
  const dbCountB = await prisma.document.count({ where: { organizationId: 'org-B' } })
  check('DB has rows for both orgs', dbCountA === 2 && dbCountB === 1, `A=${dbCountA} B=${dbCountB}`)

  // isolation
  const aList = await list('alice', 'org-A')
  const bList = await list('bob', 'org-B')
  check('org A sees only org A rows', JSON.stringify(aList.data.map((d) => d.title).sort()) === '["A-secret","A2"]', `A=${JSON.stringify(aList.data.map((d) => d.title))}`)
  check('org B sees only org B rows', JSON.stringify(bList.data.map((d) => d.title)) === '["B1"]', `B=${JSON.stringify(bList.data.map((d) => d.title))}`)

  // same-org sharing (different user, same org)
  const a2 = await list('alice2', 'org-A')
  check('same-org member shares rows', a2.data.length === 2, `count=${a2.data.length}`)

  // cross-org read by id → 404
  const bDoc = await (await post('B-only', 'bob', 'org-B')).json() as { data: { id: string } }
  const crossRead = await app.request(`/documents/${bDoc.data.id}`, { headers: { Authorization: `Bearer ${await token('alice', 'org-A')}` } })
  check('cross-org read by id → 404', crossRead.status === 404, `status=${crossRead.status}`)

  await prisma.$disconnect()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== ${passed}/${results.length} scope scenarios passed on real PostgreSQL ===`)
  process.exit(passed === results.length ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(2) })
