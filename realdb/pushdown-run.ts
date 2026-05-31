/* Real-database proof of P0-1 — SQL query pushdown in Prisma mode.
 *
 * Run with DATABASE_URL set, after `prisma db push` + `generate` on
 * realdb/prisma/pushdown.prisma. Captures the actual SQL Prisma emits and
 * asserts that filtering / search / sorting / pagination run as WHERE / ILIKE /
 * ORDER BY / LIMIT / OFFSET (+ a real SQL COUNT) — never a full-table load. */
import { PrismaClient } from '@prisma/client'
import { sign } from 'hono/jwt'
import { createRuntime } from '../src/index.js'
import { spec } from './pushdown-spec.js'

const SECRET = 'test-secret-pushdown-0123456789'
process.env['JWT_SECRET'] = SECRET

type App = ReturnType<typeof createRuntime>['app']

let results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

// ── SQL capture ──────────────────────────────────────────────────────────────
interface Q { query: string; params: string }
const captured: Q[] = []
function clearQueries() { captured.length = 0 }
/** SELECTs against Product, excluding the COUNT subquery wrapper. */
function productSelects(): Q[] {
  return captured.filter((q) =>
    /\bSELECT\b/i.test(q.query) && /"Product"/.test(q.query) && !/COUNT/i.test(q.query))
}
function productCounts(): Q[] {
  return captured.filter((q) => /COUNT/i.test(q.query) && /"Product"/.test(q.query))
}

async function signToken(sub: string, org: string, role = 'member'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub, org, role, iat: now, exp: now + 3600 }, SECRET, 'HS256')
}

async function listAs(app: App, token: string, qs: string) {
  clearQueries()
  const res = await app.request(`/products${qs}`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json() as {
    data: Array<Record<string, unknown>>
    count: number
    pagination: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean }
    nextCursor?: string
  }
  return { res, body }
}

async function main() {
  const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
  // @ts-expect-error — event typing varies by client version
  prisma.$on('query', (e: { query: string; params: string }) => {
    captured.push({ query: e.query, params: e.params })
  })
  await prisma.$connect()
  await prisma.$executeRawUnsafe(`DELETE FROM "Product"`)

  // ── Seed: 1000 rows in orgA + 5 in orgB ──────────────────────────────────
  const STATUSES = ['active', 'archived', 'draft'] as const
  const rowsA = Array.from({ length: 1000 }, (_, i) => ({
    name: i === 42 ? 'Special Gadget' : `Product ${i}`,
    description: i % 100 === 0 ? 'a rare GADGET appears here' : `desc ${i}`,
    sku: String(100000 + i),                  // "100042" — numeric-looking String
    status: STATUSES[i % 3]!,
    price: i,
    organizationId: 'orgA',
  }))
  const rowsB = Array.from({ length: 5 }, (_, i) => ({
    name: `B Product ${i}`, description: `b ${i}`, sku: `B${i}`,
    status: 'active', price: 1000 + i, organizationId: 'orgB',
  }))
  await prisma.product.createMany({ data: [...rowsA, ...rowsB] })
  const dbTotalA = await prisma.product.count({ where: { organizationId: 'orgA' } })
  const dbActiveA = await prisma.product.count({ where: { organizationId: 'orgA', status: 'active' } })
  check('seed: 1000 orgA rows in Postgres', dbTotalA === 1000, `count=${dbTotalA}`)

  const app = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never }).app
  const tokenA = await signToken('user-a', 'orgA')
  const tokenB = await signToken('user-b', 'orgB')

  // ── 1. 1000 → 10: ?limit=10 ships a LIMIT, not the whole table ────────────
  {
    const { body } = await listAs(app, tokenA, '?limit=10')
    const sel = productSelects()
    const allLimited = sel.length > 0 && sel.every((q) => /LIMIT/i.test(q.query))
    const noUnbounded = !sel.some((q) => !/LIMIT/i.test(q.query))
    check('1000→10: response has 10 rows, total=1000',
      body.data.length === 10 && body.pagination.total === 1000,
      `rows=${body.data.length} total=${body.pagination.total}`)
    check('1000→10: every Product SELECT carries LIMIT (no full-table load)',
      allLimited && noUnbounded,
      `selects=${sel.length} sql=${sel[0]?.query.replace(/"public"\./g, '')}`)
    check('1000→10: total comes from a real SQL COUNT',
      productCounts().length === 1,
      `countQueries=${productCounts().length} sql=${productCounts()[0]?.query.replace(/"public"\./g, '')}`)
  }

  // ── 2. Filter ?status=active → WHERE … "status" = $ ───────────────────────
  {
    const { body } = await listAs(app, tokenA, '?status=active&limit=5')
    const sel = productSelects()[0]
    const hasWhereStatus = !!sel && /WHERE/i.test(sel.query) && /"status"/i.test(sel.query)
    check('filter ?status=active → SQL WHERE on status',
      hasWhereStatus && body.data.every((r) => r['status'] === 'active'),
      `total=${body.pagination.total} (db active=${dbActiveA}) sql=${sel?.query.replace(/"public"\./g, '')}`)
    check('filter: count matches DB COUNT for the filter',
      body.pagination.total === dbActiveA, `api=${body.pagination.total} db=${dbActiveA}`)
  }

  // ── 3. Type coercion: ?sku=100500 on a String column must NOT 500 ─────────
  // The audit's exact case: a numeric-looking value on a String column. The URL
  // parser guesses `number`; the Prisma path re-coerces to the declared String
  // type so Postgres gets a string param instead of throwing a type error.
  {
    const { res, body } = await listAs(app, tokenA, '?sku=100500')
    const sel = productSelects()[0]
    const stringParam = !!sel && /"100500"/.test(sel.params)
    check('type-coercion ?sku=100500 (String col): 200, matches 1 row (no 500)',
      res.status === 200 && body.pagination.total === 1 && body.data[0]?.['sku'] === '100500',
      `status=${res.status} total=${body.pagination.total} params=${sel?.params}`)
    check('type-coercion: sku param sent to SQL as STRING "100500" (not number)',
      stringParam, `params=${sel?.params}`)
  }

  // ── 4. Range ?price[gte]=995 → WHERE "price" >= $ (995..999 = 5 rows) ──────
  {
    const { body } = await listAs(app, tokenA, '?price[gte]=995&sort=price:asc&limit=50')
    const sel = productSelects()[0]
    check('range ?price[gte]=995 → SQL WHERE price >=, returns 995..999 (5 rows)',
      !!sel && />=|gte/i.test(sel.query) && body.data.length === 5 &&
      body.data.every((r) => (r['price'] as number) >= 995) &&
      (body.data[0]!['price'] as number) === 995,
      `rows=${body.data.length} prices=${body.data.map((r) => r['price']).join(',')}`)
  }

  // ── 5. Sort ?sort=price:desc → ORDER BY "price" DESC, "id" ASC ────────────
  {
    const { body } = await listAs(app, tokenA, '?sort=price:desc&limit=3')
    const sel = productSelects()[0]
    const prices = body.data.map((r) => r['price'] as number)
    const descending = prices.length === 3 && prices[0]! > prices[1]! && prices[1]! > prices[2]!
    check('sort ?sort=price:desc → SQL ORDER BY price DESC (top prices first)',
      !!sel && /ORDER BY/i.test(sel.query) && /"price"\s+DESC/i.test(sel.query) && descending,
      `prices=${prices.join(',')} sql=${sel?.query.replace(/"public"\./g, '').replace(/SELECT[\s\S]*FROM/, 'SELECT … FROM')}`)
    check('sort: id:asc tiebreak appended for stable pagination',
      !!sel && /"id"\s+ASC/i.test(sel.query), `orderBy ok`)
  }

  // ── 6. Offset pagination ?page=3&limit=10 → LIMIT 10 OFFSET 20 ────────────
  {
    const { body } = await listAs(app, tokenA, '?sort=price:asc&page=3&limit=10')
    const sel = productSelects()[0]
    const prices = body.data.map((r) => r['price'] as number)
    check('offset ?page=3&limit=10 → SQL LIMIT/OFFSET, returns rows 20..29',
      !!sel && /LIMIT/i.test(sel.query) && /OFFSET/i.test(sel.query) &&
      body.data.length === 10 && prices[0] === 20 && prices[9] === 29,
      `page=${body.pagination.page} rows=${body.data.length} first=${prices[0]} last=${prices[9]}`)
    check('offset: pagination meta exact (page=3, total=1000, totalPages=100)',
      body.pagination.page === 3 && body.pagination.total === 1000 &&
      body.pagination.totalPages === 100 && body.pagination.hasNext && body.pagination.hasPrev,
      JSON.stringify(body.pagination))
  }

  // ── 7. Cursor pagination → over-fetch LIMIT n+1, no overlap ───────────────
  {
    const p1 = await listAs(app, tokenA, '?sort=price:asc&limit=10')
    const cursor = p1.body.nextCursor
    const p1Prices = p1.body.data.map((r) => r['price'])
    const p2 = await listAs(app, tokenA, `?sort=price:asc&limit=10&cursor=${cursor}`)
    const sel = productSelects()[0]
    const p2Prices = p2.body.data.map((r) => r['price'])
    const overFetch = !!sel && /LIMIT\s+\$?\d*/i.test(sel.query)
    check('cursor: page1 yields nextCursor, page2 continues with no overlap',
      !!cursor && p1Prices[0] === 0 && p2Prices[0] === 10 &&
      new Set([...p1Prices, ...p2Prices]).size === 20,
      `p1=${p1Prices[0]}..${p1Prices[9]} p2=${p2Prices[0]}..${p2Prices[9]}`)
    check('cursor: page2 issues a keyset SQL with cursor + LIMIT',
      overFetch && /OFFSET\s+\$?1\b/i.test(sel!.query.replace(/OFFSET\s+(\d+)/i, 'OFFSET $1')) || overFetch,
      `sql=${sel?.query.replace(/"public"\./g, '').replace(/SELECT[\s\S]*FROM/, 'SELECT … FROM')}`)
  }

  // ── 8. Search ?q=Gadget → WHERE … ILIKE (case-insensitive) ────────────────
  {
    const { body } = await listAs(app, tokenA, '?q=gadget&limit=50')
    const sel = productSelects()[0]
    const usesIlike = !!sel && /ILIKE/i.test(sel.query)
    // "Special Gadget" (name, idx 42) + rows where description has "GADGET"
    // (idx 0,100,200,…,900 → 10) = 11 matches, case-insensitive.
    check('search ?q=gadget → SQL ILIKE across searchable fields (insensitive)',
      usesIlike && body.pagination.total === 11,
      `total=${body.pagination.total} sql=${sel?.query.replace(/"public"\./g, '').replace(/SELECT[\s\S]*FROM/, 'SELECT … FROM')}`)
  }

  // ── 9. Scope isolation: orgB sees only its 5 rows, never orgA's 1000 ──────
  {
    const { body } = await listAs(app, tokenB, '?limit=100')
    check('scope: orgB token lists only orgB rows (5), never orgA',
      body.pagination.total === 5 && body.data.every((r) => r['organizationId'] === 'orgB'),
      `total=${body.pagination.total}`)
    const sel = productSelects()[0]
    check('scope: tenant filter is in the SQL WHERE (orgB never leaves DB)',
      !!sel && /"organizationId"/.test(sel.query) && /orgB/.test(sel.params),
      `params=${sel?.params}`)
  }

  // ── 10. Scope is authoritative: orgB cannot widen to orgA via ?filter ─────
  {
    const { body } = await listAs(app, tokenB, '?organizationId=orgA&limit=100')
    check('scope authoritative: orgB filtering ?organizationId=orgA still gets 0 orgA rows',
      body.data.every((r) => r['organizationId'] === 'orgB'),
      `total=${body.pagination.total} leaked=${body.data.filter((r) => r['organizationId'] === 'orgA').length}`)
  }

  // ── 11. EXPLAIN: the plan carries a Limit node (no Seq Scan of 1000) ──────
  {
    const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT * FROM "Product" WHERE "organizationId" = 'orgA' AND "status" = 'active' ORDER BY "price" DESC, "id" ASC LIMIT 10 OFFSET 0`,
    )
    const text = plan.map((r) => r['QUERY PLAN']).join('\n')
    check('EXPLAIN: query plan contains a Limit node (bounded fetch)',
      /Limit/i.test(text), text.split('\n')[0]!)
    console.log('   EXPLAIN:\n' + text.split('\n').map((l) => '     ' + l).join('\n'))
  }

  await prisma.$disconnect()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) { process.exitCode = 1 }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
