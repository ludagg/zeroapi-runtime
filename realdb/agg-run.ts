/* Real-PostgreSQL verification of aggregates, incl. anti-N+1 (real query count). */
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { spec } from './agg-spec.js'

const results: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

async function main() {
  let groupByQueries = 0
  const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
  ;(prisma as unknown as { $on: (e: 'query', cb: (ev: { query: string }) => void) => void })
    .$on('query', (ev) => { if (/GROUP BY/i.test(ev.query)) groupByQueries++ })
  await prisma.$connect()
  for (const t of ['Comment', 'Order', 'Account']) await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)

  const app = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never }).app
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = (r: Response) => r.json() as any

  // One account with known order totals [10,20,30] + 2 comments.
  const ada = await j(await post('/accounts', { name: 'Ada' }))
  for (const total of [10, 20, 30]) await post('/orders', { total, accountId: ada.data.id })
  for (const text of ['c1', 'c2']) await post('/comments', { text, accountId: ada.data.id })

  const one = await j(await app.request(`/accounts/${ada.data.id}?include=orderCount,totalSpent,avgOrder,minOrder,maxOrder,commentCount`))
  check('count/sum/avg/min/max + commentCount correct', one.data.orderCount === 3 && one.data.totalSpent === 60 && one.data.avgOrder === 20 && one.data.minOrder === 10 && one.data.maxOrder === 30 && one.data.commentCount === 2,
    JSON.stringify({ c: one.data.orderCount, s: one.data.totalSpent, a: one.data.avgOrder, mn: one.data.minOrder, mx: one.data.maxOrder, cc: one.data.commentCount }))

  // empty account → 0 / null
  const empty = await j(await post('/accounts', { name: 'Empty' }))
  const e = await j(await app.request(`/accounts/${empty.data.id}?include=orderCount,avgOrder`))
  check('empty account → count 0, avg null', e.data.orderCount === 0 && e.data.avgOrder === null, JSON.stringify({ c: e.data.orderCount, a: e.data.avgOrder }))

  // ── anti-N+1 on a list of many accounts ──
  for (let i = 0; i < 20; i++) {
    const a = await j(await post('/accounts', { name: `a${i}` }))
    await post('/orders', { total: i, accountId: a.data.id })
    await post('/comments', { text: 'c', accountId: a.data.id })
  }
  groupByQueries = 0
  const list = await j(await app.request('/accounts?include=orderCount,totalSpent,avgOrder,commentCount&limit=100'))
  check('list returns all 22 accounts', list.data.length === 22, `count=${list.data.length}`)
  check('anti-N+1: exactly 2 GROUP BY queries for 22 rows (orders + comments)', groupByQueries === 2, `groupByQueries=${groupByQueries}`)

  await prisma.$disconnect()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== ${passed}/${results.length} aggregate scenarios passed on real PostgreSQL ===`)
  process.exit(passed === results.length ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(2) })
