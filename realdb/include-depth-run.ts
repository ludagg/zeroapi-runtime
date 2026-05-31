/* Real-database proof of the ?include= depth guard (Prisma mode).
 *   - include within the limit → nested data is returned
 *   - include beyond the limit → 400 BEFORE any query runs (zero SQL)
 *   - the limit is configurable via RuntimeOptions.maxIncludeDepth
 * Run with DATABASE_URL set, after db push + generate on realdb/prisma/include-depth.prisma. */
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { spec } from './include-depth-spec.js'

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}
const json = (r: Response) => r.json() as Promise<any>

async function main() {
  // Query logging so we can PROVE the deep include never hits the database.
  const captured: string[] = []
  const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
  // @ts-expect-error event typing varies by client version
  prisma.$on('query', (e: { query: string }) => { captured.push(e.query) })
  await prisma.$connect()
  for (const t of ['Comment', 'Post', 'Author', 'City', 'Country', 'Continent']) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)
  }

  // Seed one full chain.
  const continent = await prisma.continent.create({ data: { name: 'Europe' } })
  const country = await prisma.country.create({ data: { name: 'France', continentId: continent.id } })
  const city = await prisma.city.create({ data: { name: 'Paris', countryId: country.id } })
  const author = await prisma.author.create({ data: { name: 'Ada', cityId: city.id } })
  const post = await prisma.post.create({ data: { title: 'Hello', authorId: author.id } })
  const comment = await prisma.comment.create({ data: { text: 'Nice', postId: post.id } })

  const app = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never }).app

  // ── 1. Within the limit (depth 4) → nested data returned ─────────────────
  {
    const res = await app.request(`/comments/${comment.id}?include=post.author.city.country`)
    const body = await json(res)
    const country4 = body?.data?.post?.author?.city?.country
    check('depth 4 (≤ default): nested data returned through the whole chain',
      res.status === 200 && country4?.name === 'France',
      `status=${res.status} country=${country4?.name}`)
  }

  // ── 2. Beyond the limit (depth 5) → 400, and ZERO SQL executed ───────────
  {
    captured.length = 0
    const res = await app.request(`/comments/${comment.id}?include=post.author.city.country.continent`)
    const body = await json(res)
    const sqlOnComment = captured.filter((q) => /SELECT/i.test(q) && /"Comment"/.test(q))
    check('depth 5 (> default): rejected with 400 "include depth exceeds maximum"',
      res.status === 400 && /Include depth exceeds maximum of 4/.test(body?.error ?? ''),
      `status=${res.status} error="${body?.error}"`)
    check('depth 5: NEVER executed — zero Comment SELECTs hit the DB',
      sqlOnComment.length === 0 && captured.length === 0,
      `commentSelects=${sqlOnComment.length} totalQueries=${captured.length}`)
  }

  // ── 3. Configurable: maxIncludeDepth: 2 rejects depth 3 ──────────────────
  {
    const app2 = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never, maxIncludeDepth: 2 }).app
    const ok2 = await app2.request(`/comments/${comment.id}?include=post.author`)              // depth 2
    const bad3 = await app2.request(`/comments/${comment.id}?include=post.author.city`)         // depth 3
    const bad3Body = await json(bad3)
    check('configurable: maxIncludeDepth=2 allows depth 2, rejects depth 3 (400)',
      ok2.status === 200 && bad3.status === 400 && /maximum of 2/.test(bad3Body?.error ?? ''),
      `depth2=${ok2.status} depth3=${bad3.status} err="${bad3Body?.error}"`)
  }

  // ── 4. List endpoint guarded too ─────────────────────────────────────────
  {
    const res = await app.request(`/comments?include=post.author.city.country.continent`)
    check('list endpoint: deep include also rejected with 400',
      res.status === 400, `status=${res.status}`)
  }

  await prisma.$disconnect()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
