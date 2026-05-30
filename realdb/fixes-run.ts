/* Real-PostgreSQL verification of the three finition fixes. */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { generateAccessToken } from '../src/auth/jwt.js'
import { spec } from './fixes-spec.js'

process.env['JWT_SECRET'] = 'realdb-fixes-secret'
const results: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

async function main() {
  const prisma = new PrismaClient()
  await prisma.$connect()
  for (const t of ['Note', 'Board', 'OrderItem', 'Order', 'Product', 'Follows', 'Person', 'RefreshToken', 'User']) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)
  }
  // ownOnly resources carry a REAL FK Note.userId → User (the fake hid this).
  // Real Postgres enforces it, so the owners must exist as User rows.
  for (const u of ['userA', 'userB', 'u']) {
    await prisma.user.create({ data: { id: u, email: `${u}@x.com`, passwordHash: 'x', salt: 'y', role: 'user' } })
  }
  const app = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never }).app
  const token = (u: string) => generateAccessToken(u, `${u}@x.com`, 'user', 'realdb-fixes-secret', 3600)
  const get = async (url: string, t?: string) =>
    app.request(url, t ? { headers: { Authorization: `Bearer ${t}` } } : {})
  const post = async (url: string, body: unknown, t?: string) =>
    app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(body) })
  const j = (r: Response) => r.json() as any

  // ── Fix 1: ownOnly on included relations ──
  {
    const tA = await token('userA'); const tB = await token('userB')
    const board = await j(await post('/boards', { title: 'shared' }, tA))
    const boardId = board.data.id
    // Two users create their own notes on the same board (ownOnly forces userId).
    await post(`/notes`, { text: 'A-note', boardId }, tA)
    await post(`/notes`, { text: 'B-note', boardId }, tB)

    const resA = await j(await get(`/boards/${boardId}?include=note`, tA))
    const resB = await j(await get(`/boards/${boardId}?include=note`, tB))
    const aNotes = (resA.data.notes ?? []).map((n: any) => n.text)
    const bNotes = (resB.data.notes ?? []).map((n: any) => n.text)
    check('Fix1 ownOnly include: each user sees only their own notes',
      JSON.stringify(aNotes) === '["A-note"]' && JSON.stringify(bNotes) === '["B-note"]',
      `A=${JSON.stringify(aNotes)} B=${JSON.stringify(bNotes)}`)
  }

  // ── Fix 2: M2M filter through association entity (custom fk prodRef) ──
  {
    const t = await token('u')
    const pA = await j(await post('/products', { name: 'A' }, t))
    const pB = await j(await post('/products', { name: 'B' }, t))
    const o1 = await j(await post('/orders', { ref: 'has-A' }, t))
    const o2 = await j(await post('/orders', { ref: 'has-B' }, t))
    await prisma.orderItem.create({ data: { id: randomUUID(), orderId: o1.data.id, prodRef: pA.data.id, qty: 1 } })
    await prisma.orderItem.create({ data: { id: randomUUID(), orderId: o2.data.id, prodRef: pB.data.id, qty: 1 } })

    const res = await j(await get(`/orders?product=${pA.data.id}`, t))
    const refs = (res.data ?? []).map((o: any) => o.ref)
    check('Fix2 M2M assoc-entity filter (custom fk prodRef)', JSON.stringify(refs) === '["has-A"]', `refs=${JSON.stringify(refs)}`)
  }

  // ── Fix 3: self-M2M direction (following vs followers) ──
  {
    const t = await token('u')
    const mk = async (h: string) => (await j(await post('/persons', { handle: h }, t))).data.id
    const alice = await mk('alice'); const bob = await mk('bob'); const carol = await mk('carol')
    await prisma.follows.create({ data: { personId: alice, relatedPersonId: bob } })
    await prisma.follows.create({ data: { personId: alice, relatedPersonId: carol } })
    await prisma.follows.create({ data: { personId: bob, relatedPersonId: alice } })

    const following = await j(await get(`/persons/${alice}?include=following`, t))
    const followers = await j(await get(`/persons/${alice}?include=followers`, t))
    const flwing = (following.data.following ?? []).map((e: any) => e.relatedPerson.handle).sort()
    const flwers = (followers.data.followers ?? []).map((e: any) => e.person.handle).sort()
    check('Fix3 self-M2M include directions (following / followers)',
      JSON.stringify(flwing) === '["bob","carol"]' && JSON.stringify(flwers) === '["bob"]',
      `following=${JSON.stringify(flwing)} followers=${JSON.stringify(flwers)}`)

    const whoFollowsBob = await j(await get(`/persons?following=${bob}`, t))
    const handles = (whoFollowsBob.data ?? []).map((p: any) => p.handle)
    check('Fix3 self-M2M filter (?following=bob → people who follow bob)',
      JSON.stringify(handles) === '["alice"]', `handles=${JSON.stringify(handles)}`)
  }

  await prisma.$disconnect()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== ${passed}/${results.length} fix scenarios passed on real PostgreSQL ===`)
  process.exit(passed === results.length ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(2) })
