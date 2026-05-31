/* Real-database proof of P0-2 — relations in Prisma mode.
 *
 * Proves the three subsystems the audit flagged as Map-only (silently broken in
 * Prisma): nested routes find the parent in the DB, nested M2M creation persists
 * join rows to the DB, and the system-resource cascade applies onDelete in the
 * DB — atomically, inside a single $transaction. Run with DATABASE_URL set,
 * after db push + generate on realdb/prisma/p0-2.prisma. */
import { PrismaClient } from '@prisma/client'
import { sign } from 'hono/jwt'
import { createRuntime } from '../src/index.js'
import { spec } from './p0-2-spec.js'

const SECRET = 'test-secret-p0-2-0123456789'
process.env['JWT_SECRET'] = SECRET

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

async function token(sub: string, org: string, role = 'member'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub, org, role, iat: now, exp: now + 3600 }, SECRET, 'HS256')
}

async function main() {
  const prisma = new PrismaClient()
  await prisma.$connect()
  // Clean slate (children before parents for FK safety).
  for (const t of ['PostHashtags', 'Post', 'Hashtag', 'Author', 'Article', 'Profile', 'AuditLog', 'Session', 'RefreshToken', 'User']) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)
  }

  const rt = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never })
  const app = rt.app
  const tokenA = await token('user-a', 'orgA')
  const tokenB = await token('user-b', 'orgB')
  const json = (r: Response) => r.json() as Promise<any>
  const authHdr = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

  // ════════════════ 1. NESTED ROUTES — parent found in the DB ════════════════
  const author = await prisma.author.create({ data: { name: 'Ada' } })
  {
    // POST /authors/:id/posts — previously 404 in Prisma (parent checked in Map).
    const res = await app.request(`/authors/${author.id}/posts`, {
      method: 'POST', headers: authHdr(tokenA), body: JSON.stringify({ title: 'Nested Post' }),
    })
    const body = await json(res)
    check('nested POST /authors/:id/posts → 201 (parent found in DB, no 404)',
      res.status === 201, `status=${res.status}`)
    check('nested create: parent FK forced from URL (authorId)',
      body?.data?.authorId === author.id, `authorId=${body?.data?.authorId}`)
    // Persisted in the DB under that parent.
    const inDb = await prisma.post.findFirst({ where: { authorId: author.id } })
    check('nested create: row persisted in Postgres under the parent',
      !!inDb && inDb.title === 'Nested Post', JSON.stringify(inDb && { id: inDb.id, authorId: inDb.authorId }))

    // GET /authors/:id/posts — lists children of an existing parent.
    const listRes = await app.request(`/authors/${author.id}/posts`, { headers: authHdr(tokenA) })
    const list = await json(listRes)
    check('nested GET /authors/:id/posts → 200 lists children',
      listRes.status === 200 && list.data.length === 1, `status=${listRes.status} count=${list.count}`)

    // Unknown parent → 404 (existence really checked against the DB).
    const missRes = await app.request(`/authors/does-not-exist/posts`, { headers: authHdr(tokenA) })
    check('nested: unknown parent id → 404 (DB existence check)',
      missRes.status === 404, `status=${missRes.status}`)
  }

  // ════════════════ 2. NESTED M2M CREATE — join rows in the DB ════════════════
  const h1 = await prisma.hashtag.create({ data: { label: 'rust' } })
  const h2 = await prisma.hashtag.create({ data: { label: 'db' } })
  {
    const res = await app.request('/posts', {
      method: 'POST', headers: authHdr(tokenA),
      body: JSON.stringify({ title: 'M2M Post', authorId: author.id, hashtags: [{ hashtagId: h1.id }, { hashtagId: h2.id }] }),
    })
    const body = await json(res)
    const postId = body?.data?.id
    check('M2M nested create → 201', res.status === 201, `status=${res.status} id=${postId}`)
    // The join rows physically exist in PostHashtags (composite PK, no id column).
    const joins = await prisma.postHashtags.findMany({ where: { postId } })
    check('M2M nested create: join rows persisted in Postgres (PostHashtags)',
      joins.length === 2 && joins.every((j: any) => j.postId === postId),
      `joins=${joins.length} hashtags=${joins.map((j: any) => j.hashtagId).length}`)

    // Bad reference → 409 and the main row is rolled back (not left orphaned).
    const beforeCount = await prisma.post.count()
    const badRes = await app.request('/posts', {
      method: 'POST', headers: authHdr(tokenA),
      body: JSON.stringify({ title: 'Bad', authorId: author.id, hashtags: [{ hashtagId: 'nope' }] }),
    })
    const afterCount = await prisma.post.count()
    check('M2M nested create: unknown related id → 409 + main row rolled back',
      badRes.status === 409 && afterCount === beforeCount, `status=${badRes.status} before=${beforeCount} after=${afterCount}`)
  }

  // ════════════════ 3. SCOPE PRESERVED on the nested route ════════════════════
  {
    // orgA created the nested post above (organizationId forced to orgA). orgB
    // must not see it through the same nested route.
    const aRes = await json(await app.request(`/authors/${author.id}/posts`, { headers: authHdr(tokenA) }))
    const bRes = await json(await app.request(`/authors/${author.id}/posts`, { headers: authHdr(tokenB) }))
    check('scope: nested create forced organizationId=orgA',
      aRes.data.every((p: any) => p.organizationId === 'orgA'), `orgA posts=${aRes.data.length}`)
    check('scope: orgB sees 0 of orgA\'s posts on the nested route (scope authoritative)',
      bRes.data.length === 0, `orgB sees=${bRes.data.length}`)
  }

  // ════════════════ 4. SYSTEM CASCADE — onDelete applied in the DB ═════════════
  async function seedUser(email: string) {
    return prisma.user.create({ data: { email, passwordHash: 'x', salt: 'y', role: 'user' } })
  }

  // ── 4a. ATOMICITY: a NoAction (DB-Restrict) Session blocks the User delete
  //        AFTER the cascade mutated children → the whole tx rolls back. ──
  {
    const u = await seedUser('atomic@test.dev')
    const art = await prisma.article.create({ data: { headline: 'keep me', userId: u.id } })
    const prof = await prisma.profile.create({ data: { bio: 'keep me', userId: u.id } })
    await prisma.session.create({ data: { token: 'sess', userId: u.id } }) // blocks delete

    let threw = false
    try { await rt.deleteSystemResource!('User', u.id) } catch { threw = true }

    const userStill = await prisma.user.findUnique({ where: { id: u.id } })
    const artStill = await prisma.article.findUnique({ where: { id: art.id } })
    const profRow = await prisma.profile.findUnique({ where: { id: prof.id } })
    check('cascade atomicity: User delete blocked by Session FK → throws',
      threw, `threw=${threw}`)
    check('cascade atomicity: ROLLBACK — Article NOT deleted, Profile.userId NOT nulled, User present',
      !!userStill && !!artStill && profRow?.userId === u.id,
      `user=${!!userStill} article=${!!artStill} profile.userId=${profRow?.userId}`)
    // clean the blocker for the next scenario
    await prisma.session.deleteMany({ where: { userId: u.id } })
    await prisma.article.deleteMany({ where: { userId: u.id } })
    await prisma.profile.deleteMany({ where: { userId: u.id } })
    await prisma.user.delete({ where: { id: u.id } })
  }

  // ── 4b. RESTRICT: an AuditLog (onDelete: Restrict) blocks via the manual
  //        pre-check (throws before mutating), nothing touched. ──
  {
    const u = await seedUser('restrict@test.dev')
    const art = await prisma.article.create({ data: { headline: 'c', userId: u.id } })
    await prisma.auditLog.create({ data: { action: 'login', userId: u.id } })

    let err = ''
    try { await rt.deleteSystemResource!('User', u.id) } catch (e) { err = (e as Error).message }
    const userStill = await prisma.user.findUnique({ where: { id: u.id } })
    const artStill = await prisma.article.findUnique({ where: { id: art.id } })
    check('cascade Restrict: throws with a clear message, User + children untouched',
      /Restrict/i.test(err) && !!userStill && !!artStill, `err="${err.slice(0, 60)}…"`)
    await prisma.auditLog.deleteMany({ where: { userId: u.id } })
    await prisma.article.deleteMany({ where: { userId: u.id } })
    await prisma.user.delete({ where: { id: u.id } })
  }

  // ── 4c. CASCADE + SETNULL: success path — children deleted / nulled in DB. ──
  {
    const u = await seedUser('cascade@test.dev')
    const a1 = await prisma.article.create({ data: { headline: 'gone1', userId: u.id } })
    const a2 = await prisma.article.create({ data: { headline: 'gone2', userId: u.id } })
    const p1 = await prisma.profile.create({ data: { bio: 'survives', userId: u.id } })

    const result = await rt.deleteSystemResource!('User', u.id)

    const userGone = await prisma.user.findUnique({ where: { id: u.id } })
    const a1Gone = await prisma.article.findUnique({ where: { id: a1.id } })
    const a2Gone = await prisma.article.findUnique({ where: { id: a2.id } })
    const profRow = await prisma.profile.findUnique({ where: { id: p1.id } })
    check('cascade Cascade: Article children deleted in DB',
      !a1Gone && !a2Gone, `a1=${!!a1Gone} a2=${!!a2Gone}`)
    check('cascade SetNull: Profile.userId set to NULL in DB (row kept)',
      !!profRow && profRow.userId === null, `profile.userId=${profRow?.userId}`)
    check('cascade: User row itself deleted (same $transaction)',
      !userGone, `userGone=${!userGone}`)
    check('cascade: CascadeResult reports real ids (deleted Article x2, setNull Profile x1)',
      (result.deleted['Article']?.length === 2) && (result.setNull['Profile']?.length === 1),
      JSON.stringify({ deleted: result.deleted, setNull: result.setNull }))
  }

  await prisma.$disconnect()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
