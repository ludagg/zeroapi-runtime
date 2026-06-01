/* Real-database proof: webhook signing secrets are encrypted at rest.
 *   - with a key: the `secret` column holds enc:v1:… (NOT the plaintext)
 *   - the HMAC signature still works (decrypted at delivery time)
 *   - a legacy PLAINTEXT secret keeps working (tolerant decrypt, no migration)
 * Run with DATABASE_URL set, after db push + generate on realdb/prisma/webhooks.prisma. */
import { PrismaClient } from '@prisma/client'
import {
  createRuntime, PrismaWebhookStore, WebhookWorker, signPayload, verifySignature,
  SIGNATURE_HEADER, EVENT_ID_HEADER,
} from '../src/index.js'
import { spec } from './webhooks-spec.js'

const KEY = 'unit-test-webhook-encryption-key-123'
const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

/** fetch that records the signature header + body it received, returns 200. */
function recordingFetch(sink: { sig?: string; body?: string; id?: string }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>
    sink.sig = h[SIGNATURE_HEADER]
    sink.id = h[EVENT_ID_HEADER]
    sink.body = typeof init?.body === 'string' ? init.body : undefined
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
}

async function main() {
  const prisma = new PrismaClient()
  await prisma.$connect()
  await prisma.$executeRawUnsafe(`DELETE FROM "WebhookEvent"`)
  await prisma.$executeRawUnsafe(`DELETE FROM "WebhookEndpoint"`)

  const rt = createRuntime(spec, {
    enableLogging: false,
    prisma: prisma as unknown as never,
    webhookSecretEncryptionKey: KEY,
    webhookWorkerAutostart: false,
  })
  const store = rt.webhooks!.store
  check('runtime uses PrismaWebhookStore', store instanceof PrismaWebhookStore, store.constructor.name)

  // ── 1. Create an endpoint with a known secret → stored ENCRYPTED ─────────
  const PLAINTEXT = 'whsec_super_secret_value_0123456789'
  const ep = await store.createEndpoint({ url: 'https://example.test/hook', events: ['order.created'], secret: PLAINTEXT })

  // Raw DB read (bypasses the store's decrypt) — must be ciphertext.
  const raw = await prisma.webhookEndpoint.findUnique({ where: { id: ep.id } })
  check('secret stored ENCRYPTED in DB (enc:v1: prefix, not plaintext)',
    typeof raw?.secret === 'string' && raw.secret.startsWith('enc:v1:') && raw.secret !== PLAINTEXT,
    `dbValue=${String(raw?.secret).slice(0, 24)}…`)
  check('createEndpoint returns the PLAINTEXT secret (shown once)',
    ep.secret === PLAINTEXT, `returned=${ep.secret === PLAINTEXT ? 'plaintext' : ep.secret}`)

  // ── 2. Read-back decrypts to the original plaintext ──────────────────────
  const fetched = await store.getEndpoint(ep.id)
  check('getEndpoint decrypts back to the original secret',
    fetched?.secret === PLAINTEXT, `decrypted=${fetched?.secret === PLAINTEXT}`)

  // ── 3. HMAC end-to-end: worker decrypts → signs → signature verifies ─────
  await store.createEvent({ endpointId: ep.id, eventType: 'order.created', payload: { item: 'x' } })
  const sink: { sig?: string; body?: string; id?: string } = {}
  const worker = new WebhookWorker(store, { fetchImpl: recordingFetch(sink) })
  await worker.runOnce()
  const sigValidWithPlaintext = !!sink.body && verifySignature(PLAINTEXT, sink.body, sink.sig)
  const matchesExpected = !!sink.body && sink.sig === signPayload(PLAINTEXT, sink.body)
  check('HMAC works: delivered signature verifies with the (decrypted) secret',
    sigValidWithPlaintext && matchesExpected, `sigValid=${sigValidWithPlaintext} matches=${matchesExpected}`)

  // ── 4. LEGACY plaintext secret (no prefix) still works ───────────────────
  const legacyPlain = 'whsec_legacy_plaintext_secret_value'
  // Insert a pre-existing plaintext secret directly (simulating data created before encryption).
  const legacy = await prisma.webhookEndpoint.create({
    data: { url: 'https://example.test/legacy', events: 'order.created', secret: legacyPlain, active: true },
  })
  const legacyRead = await store.getEndpoint(legacy.id)
  check('legacy plaintext secret returned as-is (tolerant decrypt, no migration)',
    legacyRead?.secret === legacyPlain, `secret=${legacyRead?.secret === legacyPlain ? 'intact' : 'broken'}`)

  await store.createEvent({ endpointId: legacy.id, eventType: 'order.created', payload: { item: 'y' } })
  const sink2: { sig?: string; body?: string } = {}
  const worker2 = new WebhookWorker(store, { workerId: 'legacy', fetchImpl: recordingFetch(sink2) })
  await worker2.runOnce()
  check('legacy: HMAC still valid with the plaintext secret',
    !!sink2.body && verifySignature(legacyPlain, sink2.body, sink2.sig), `sigValid=${!!sink2.body && verifySignature(legacyPlain, sink2.body, sink2.sig)}`)

  await prisma.$disconnect()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
