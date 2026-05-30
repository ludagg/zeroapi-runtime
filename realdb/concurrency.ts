/* Harder concurrency proof against real Postgres. */
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { spec } from './spec.js'

const prisma = new PrismaClient()
const app = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never }).app
const post = (p: string, b: unknown) =>
  app.request(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })

async function run(stock: number, concurrency: number, label: string) {
  await prisma.$executeRawUnsafe('DELETE FROM "Purchase"')
  await prisma.$executeRawUnsafe('DELETE FROM "Product"')
  const product = await (await post('/products', { name: 'w', stock })).json() as any
  const productId = product.data.id
  const responses = await Promise.all(
    Array.from({ length: concurrency }, () => post('/purchases', { productId, quantity: 1 })),
  )
  const statuses = responses.map((r) => r.status)
  const n201 = statuses.filter((s) => s === 201).length
  const n409 = statuses.filter((s) => s === 409).length
  const finalStock = (await prisma.product.findUnique({ where: { id: productId } }))?.stock
  const purchases = await prisma.purchase.count()
  const ok = n201 === stock && n409 === concurrency - stock && finalStock === 0 && purchases === stock
  console.log(`${ok ? '✅' : '❌'} ${label}: stock=${stock} conc=${concurrency} → 201=${n201} 409=${n409} finalStock=${finalStock} purchases=${purchases}`)
  return ok
}

async function main() {
  await prisma.$connect()
  let allOk = true
  // Determinism: repeat the stock=1 case several times.
  for (let i = 1; i <= 5; i++) allOk = await run(1, 10, `repeat#${i} (expect 1×201/9×409)`) && allOk
  // Higher concurrency with multiple winners.
  allOk = await run(3, 20, 'multi-winner (expect 3×201/17×409)') && allOk
  allOk = await run(5, 50, 'high (expect 5×201/45×409)') && allOk
  await prisma.$disconnect()
  console.log(allOk ? '\nALL DETERMINISTIC ✅' : '\nNON-DETERMINISTIC ❌')
  process.exit(allOk ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(2) })
