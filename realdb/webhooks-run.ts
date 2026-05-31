/* Real-database proof of the Prisma webhook store.
 *   - createRuntime auto-wires PrismaWebhookStore when Prisma is active
 *   - endpoints + queued events SURVIVE a restart (new client/runtime, same DB)
 *   - delivery RESUMES after restart (pending events re-read from the DB)
 *   - claim locks the row; concurrent workers never double-deliver
 * Run with DATABASE_URL set, after db push + generate on realdb/prisma/webhooks.prisma. */
import { PrismaClient } from '@prisma/client'
import {
  createRuntime, PrismaWebhookStore, WebhookWorker, generateWebhookSecret,
  EVENT_ID_HEADER,
} from '../src/index.js'
import { spec } from './webhooks-spec.js'

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

/** A fetch that always succeeds (2xx) and records which event ids it received. */
function recordingFetch(log: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const id = headers[EVENT_ID_HEADER] ?? headers[EVENT_ID_HEADER.toLowerCase()]
    if (id) log.push(id)
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
}

async function main() {
  const prisma = new PrismaClient()
  await prisma.$connect()
  await prisma.$executeRawUnsafe(`DELETE FROM "WebhookEvent"`)
  await prisma.$executeRawUnsafe(`DELETE FROM "WebhookEndpoint"`)

  // ── A. Auto-wiring ───────────────────────────────────────────────────────
  const rt1 = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never, webhookWorkerAutostart: false })
  check('auto-wiring: runtime uses PrismaWebhookStore when Prisma is active',
    rt1.webhooks?.store instanceof PrismaWebhookStore, `store=${rt1.webhooks?.store?.constructor.name}`)

  // ── B. Create endpoint + queue an event, then SIMULATE A RESTART ─────────
  const store1 = rt1.webhooks!.store
  const ep = await store1.createEndpoint({ url: 'https://example.test/hook', events: ['order.created'], secret: generateWebhookSecret() })
  const ev = await store1.createEvent({ endpointId: ep.id, eventType: 'order.created', payload: { item: 'widget' } })
  check('queue: event created as pending', ev.status === 'pending', `status=${ev.status}`)

  // Brand-new client + store = restart, same database.
  const prisma2 = new PrismaClient()
  await prisma2.$connect()
  const store2 = new PrismaWebhookStore(prisma2 as never)

  const epAfter = (await store2.listEndpoints()).find((e) => e.id === ep.id)
  check('restart: endpoint SURVIVES (re-read from DB)', !!epAfter && epAfter.url === ep.url, `found=${!!epAfter}`)
  const evAfter = await store2.getEvent(ev.id)
  check('restart: queued event SURVIVES as pending (re-read from DB)',
    !!evAfter && evAfter.status === 'pending', `status=${evAfter?.status}`)

  // ── C. Delivery RESUMES after restart ────────────────────────────────────
  const log: string[] = []
  const worker2 = new WebhookWorker(store2, { fetchImpl: recordingFetch(log) })
  const n = await worker2.runOnce()
  const evDelivered = await store2.getEvent(ev.id)
  check('resume: post-restart worker claims & DELIVERS the pending event',
    n === 1 && log.includes(ev.id) && evDelivered?.status === 'delivered',
    `claimed=${n} deliveredStatus=${evDelivered?.status}`)
  check('resume: deliveredAt set + lock cleared in DB',
    evDelivered?.deliveredAt != null && evDelivered?.lockedAt == null && evDelivered?.lockedBy == null,
    `deliveredAt=${evDelivered?.deliveredAt ? 'set' : 'null'} lockedBy=${evDelivered?.lockedBy}`)

  // ── D. Claim LOCKS the row (visible in DB before delivery) ────────────────
  const ev2 = await store2.createEvent({ endpointId: ep.id, eventType: 'order.created', payload: { item: 'locked' } })
  const claimed = await store2.claimReadyEvents({ workerId: 'worker-D', batchSize: 10 })
  const lockedRow = await store2.getEvent(ev2.id)
  check('lock: claim sets lockedBy/lockedAt on the row in DB',
    claimed.some((c) => c.id === ev2.id) && lockedRow?.lockedBy === 'worker-D' && lockedRow?.lockedAt != null,
    `lockedBy=${lockedRow?.lockedBy}`)
  // release it so it doesn't interfere with the concurrency test
  await store2.updateAfterAttempt({ id: ev2.id, status: 'delivered', attempts: 1, nextRetryAt: null, lastError: null, deliveredAt: new Date() })

  // ── E. CONCURRENCY: two workers, each event delivered EXACTLY once ────────
  const endpoint = await store2.createEndpoint({ url: 'https://example.test/hook2', events: ['order.created'], secret: generateWebhookSecret() })
  const N = 30
  for (let i = 0; i < N; i++) {
    await store2.createEvent({ endpointId: endpoint.id, eventType: 'order.created', payload: { i } })
  }
  const cLog: string[] = []
  const wA = new WebhookWorker(store2, { workerId: 'A', batchSize: 5, fetchImpl: recordingFetch(cLog) })
  const wB = new WebhookWorker(store2, { workerId: 'B', batchSize: 5, fetchImpl: recordingFetch(cLog) })
  // Drain the queue with both workers running CONCURRENTLY.
  for (let round = 0; round < 10; round++) {
    const [a, b] = await Promise.all([wA.runOnce(), wB.runOnce()])
    if (a === 0 && b === 0) break
  }
  const pendingLeft = (await store2.listEventsForEndpoint(endpoint.id, 1000)).filter((e) => e.status !== 'delivered').length
  const deliveredForThisEndpoint = cLog.length
  const uniqueDelivered = new Set(cLog).size
  check('concurrency: all 30 events delivered, none left pending',
    pendingLeft === 0 && uniqueDelivered === N, `unique=${uniqueDelivered}/${N} pendingLeft=${pendingLeft}`)
  check('concurrency: NO double-delivery (every event delivered exactly once)',
    deliveredForThisEndpoint === uniqueDelivered, `totalDeliveries=${deliveredForThisEndpoint} unique=${uniqueDelivered}`)

  await prisma.$disconnect()
  await prisma2.$disconnect()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
