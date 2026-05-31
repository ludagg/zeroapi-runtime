/* Real-database proof of readiness (DB ping) + graceful shutdown.
 *   - /ready: 200 in memory, 200 with DB up, 503 with the cluster STOPPED,
 *     200 again once restarted
 *   - shutdown(): stops the webhook worker + disconnects Prisma; memory = no-op
 * Run with DATABASE_URL set, after db push + generate on realdb/prisma/ready-shutdown.prisma.
 * Needs passwordless `sudo -u postgres pg_ctlcluster` to stop/start the cluster. */
import { execSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { spec } from './ready-shutdown-spec.js'

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}
const sh = (cmd: string) => execSync(cmd, { stdio: 'pipe' }).toString().trim()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const readyStatus = async (app: ReturnType<typeof createRuntime>['app']) => {
  const res = await app.request('/ready')
  return { status: res.status, body: await res.json() as { status: string; database?: string } }
}

async function main() {
  // ── /ready in MEMORY mode → 200 (no DB to probe) ─────────────────────────
  // Unset DATABASE_URL so the runtime doesn't auto-detect Prisma (true memory).
  {
    const saved = process.env['DATABASE_URL']
    delete process.env['DATABASE_URL']
    const { app } = createRuntime(spec, { enableLogging: false, webhookWorkerAutostart: false })
    const r = await readyStatus(app)
    if (saved !== undefined) process.env['DATABASE_URL'] = saved
    check('/ready memory mode → 200 (database: skipped)',
      r.status === 200 && r.body.database === 'skipped', `status=${r.status} db=${r.body.database}`)
  }

  // ── /ready in PRISMA mode ────────────────────────────────────────────────
  const prisma = new PrismaClient()
  await prisma.$connect()
  const rt = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never, webhookWorkerAutostart: false })

  const up = await readyStatus(rt.app)
  check('/ready Prisma, DB UP → 200 (SELECT 1 ok)',
    up.status === 200 && up.body.database === 'ok', `status=${up.status} db=${up.body.database}`)

  // Stop the cluster → the SELECT 1 must fail → 503.
  sh('sudo -u postgres pg_ctlcluster 16 main stop')
  await sleep(500)
  const down = await readyStatus(rt.app)
  check('/ready Prisma, cluster STOPPED → 503 (database unreachable)',
    down.status === 503 && down.body.database === 'unreachable', `status=${down.status} db=${down.body.database}`)

  // Restart the cluster → readiness recovers → 200.
  sh('sudo -u postgres pg_ctlcluster 16 main start')
  let recovered = { status: 0, body: { status: '', database: '' as string | undefined } }
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try { recovered = await readyStatus(rt.app) } catch { /* reconnecting */ }
    if (recovered.status === 200) break
  }
  check('/ready Prisma, cluster RESTARTED → 200 again (recovers)',
    recovered.status === 200 && recovered.body.database === 'ok', `status=${recovered.status} db=${recovered.body.database}`)

  // ── /health stays liveness-only (unchanged) ──────────────────────────────
  {
    const res = await rt.app.request('/health')
    const body = await res.json() as { status: string; uptime: number }
    check('/health unchanged (liveness/uptime, 200)', res.status === 200 && body.status === 'ok', `status=${res.status}`)
  }

  // ── shutdown(): stop worker + disconnect, idempotent ─────────────────────
  {
    const p2 = new PrismaClient()
    await p2.$connect()
    let disconnects = 0
    const origDisc = p2.$disconnect.bind(p2)
    ;(p2 as unknown as { $disconnect: () => Promise<void> }).$disconnect = async () => { disconnects++; return origDisc() }

    const rt2 = createRuntime(spec, { enableLogging: false, prisma: p2 as unknown as never })
    let stopCalls = 0
    const worker = rt2.webhooks!.worker
    const origStop = worker.stop.bind(worker)
    worker.stop = () => { stopCalls++; origStop() }

    await rt2.shutdown()
    check('shutdown: webhook worker stopped + Prisma disconnected',
      stopCalls === 1 && disconnects >= 1, `workerStop=${stopCalls} disconnects=${disconnects}`)

    await rt2.shutdown() // idempotent
    check('shutdown: idempotent (second call does nothing)',
      stopCalls === 1 && disconnects >= 1, `workerStop=${stopCalls} disconnects=${disconnects}`)
  }

  // ── shutdown() in memory mode → no-op that resolves ──────────────────────
  {
    const memRt = createRuntime(spec, { enableLogging: false })
    let threw = false
    try { await memRt.shutdown() } catch { threw = true }
    check('shutdown: memory mode is a no-op that resolves cleanly', !threw, `threw=${threw}`)
  }

  await prisma.$disconnect()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
