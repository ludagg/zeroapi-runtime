/* Real-database E2E. Run with DATABASE_URL set, after `prisma db push`. */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { spec } from './spec.js'

type App = ReturnType<typeof createRuntime>['app']
const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

function newRuntime(client: PrismaClient): App {
  return createRuntime(spec, { enableLogging: false, prisma: client as unknown as never }).app
}
const json = (r: Response) => r.json() as Promise<any>
async function post(app: App, path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function main() {
  const prisma = new PrismaClient()
  await prisma.$connect()
  // Clean slate.
  for (const t of ['Purchase', 'Product', 'PostHashtags', 'Comment', 'Post', 'Hashtag', 'Author', 'Follows', 'Person', 'Todo']) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)
  }

  // ───────────────────────── PERSISTENCE ─────────────────────────
  let todoId = ''
  {
    const app = newRuntime(prisma)
    const res = await post(app, '/todos', { title: 'buy milk' })
    const body = await json(res)
    todoId = body?.data?.id
    check('persistence: POST /todos returns 201', res.status === 201, `status=${res.status} id=${todoId}`)
    const inDb = await prisma.todo.findUnique({ where: { id: todoId } })
    check('persistence: row present in Postgres', !!inDb && inDb.title === 'buy milk', JSON.stringify(inDb))
  }

  // ───────────────────────── RESTART ─────────────────────────
  {
    // Brand-new client + runtime = simulated process restart, same DB.
    const prisma2 = new PrismaClient()
    await prisma2.$connect()
    const app2 = newRuntime(prisma2)
    const res = await app2.request(`/todos/${todoId}`)
    const body = await json(res)
    check('restart: todo survives a fresh runtime+client', res.status === 200 && body?.data?.id === todoId,
      `status=${res.status} title=${body?.data?.title}`)
    await prisma2.$disconnect()
  }

  // ───────────────────────── RELATIONS / NESTED INCLUDES ─────────────────────────
  {
    const app = newRuntime(prisma)
    const author = await json(await post(app, '/authors', { name: 'Ada' }))
    const post1 = await json(await post(app, '/posts', { title: 'Hello' }))
    const authorId = author.data.id, postId = post1.data.id
    await post(app, '/comments', { text: 'first', postId, authorId })
    await post(app, '/comments', { text: 'second', postId, authorId })

    const res = await app.request(`/posts/${postId}?include=comment.author`)
    const body = await json(res)
    const comments = body?.data?.comments ?? []
    const nestedOk = res.status === 200 && comments.length === 2 &&
      comments.every((c: any) => c.author && c.author.name === 'Ada')
    check('relations: nested include Post→Comments→Author (1 call)', nestedOk,
      `status=${res.status} comments=${comments.length} firstAuthor=${comments[0]?.author?.name}`)
  }

  // ───────────────────────── MANY-TO-MANY (include + filter) ─────────────────────────
  {
    const app = newRuntime(prisma)
    const techPost = await json(await post(app, '/posts', { title: 'About Rust' }))
    const foodPost = await json(await post(app, '/posts', { title: 'About Pasta' }))
    const tech = await json(await post(app, '/hashtags', { label: 'tech' }))
    const food = await json(await post(app, '/hashtags', { label: 'food' }))
    // Seed join rows directly (join tables aren't routed resources).
    await prisma.postHashtags.create({ data: { postId: techPost.data.id, hashtagId: tech.data.id } })
    await prisma.postHashtags.create({ data: { postId: foodPost.data.id, hashtagId: food.data.id } })

    const inc = await json(await (await fetch0(app, `/posts/${techPost.data.id}?include=hashtag`)))
    const incOk = inc?.data?.postHashtags?.length === 1 && inc.data.postHashtags[0].hashtag.label === 'tech'
    check('m2m: include hashtags through join', incOk, JSON.stringify(inc?.data?.postHashtags))

    const filt = await json(await fetch0(app, `/posts?hashtag=${tech.data.id}`))
    const titles = (filt?.data ?? []).map((p: any) => p.title)
    check('m2m: filter posts by hashtag (?hashtag=)', titles.length === 1 && titles[0] === 'About Rust',
      `titles=${JSON.stringify(titles)}`)
  }

  // ───────────────────────── SELF-M2M ─────────────────────────
  {
    const app = newRuntime(prisma)
    const alice = await json(await post(app, '/persons', { handle: 'alice' }))
    const bob = await json(await post(app, '/persons', { handle: 'bob' }))
    await prisma.follows.create({ data: { personId: alice.data.id, relatedPersonId: bob.data.id } })
    const list = await json(await fetch0(app, '/persons'))
    const handles = (list?.data ?? []).map((p: any) => p.handle).sort()
    check('self-m2m: persons queryable + follow edge persisted', handles.join(',') === 'alice,bob',
      `handles=${JSON.stringify(handles)} follows=${await prisma.follows.count()}`)
  }

  // ───────────────────────── TRANSACTIONS (real concurrency) ─────────────────────────
  {
    const app = newRuntime(prisma)
    const product = await json(await post(app, '/products', { name: 'widget', stock: 1 }))
    const productId = product.data.id
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post(app, '/purchases', { productId, quantity: 1 })),
    )
    const statuses = responses.map((r) => r.status)
    const n201 = statuses.filter((s) => s === 201).length
    const n409 = statuses.filter((s) => s === 409).length
    const finalStock = (await prisma.product.findUnique({ where: { id: productId } }))?.stock
    const purchases = await prisma.purchase.count()
    check('transactions: 10 concurrent on stock=1 → exactly 1×201 / 9×409',
      n201 === 1 && n409 === 9 && finalStock === 0 && purchases === 1,
      `201=${n201} 409=${n409} finalStock=${finalStock} purchases=${purchases} statuses=${statuses.join(',')}`)
  }

  await prisma.$disconnect()

  // ── summary ──
  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== ${passed}/${results.length} scenarios passed ===`)
  process.exit(passed === results.length ? 0 : 1)
}

// Hono's app.request returns Response | Promise<Response>; normalise.
async function fetch0(app: App, url: string): Promise<Response> {
  return app.request(url)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
