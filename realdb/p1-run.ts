/* Real-database proof of P1 security fixes.
 *   1. access-token revocation on logout      → revoked token rejected
 *   2. user deletion cuts all live sessions    → token rejected after delete
 *   3. no configured secret                     → token REFUSED (fail closed)
 *   4. brute-force on /auth/login               → per-IP rate limit (429)
 * Run with DATABASE_URL set, after db push + generate on realdb/prisma/p1.prisma. */
import { PrismaClient } from '@prisma/client'
import { createRuntime } from '../src/index.js'
import { spec } from './p1-spec.js'

process.env['JWT_SECRET'] = 'p1-proof-secret-0123456789-abcdef'

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}
const json = (r: Response) => r.json() as Promise<any>

async function main() {
  const prisma = new PrismaClient()
  await prisma.$connect()
  for (const t of ['Secret', 'RevokedToken', 'RefreshToken', 'User']) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)
  }

  const rt = createRuntime(spec, { enableLogging: false, prisma: prisma as unknown as never })
  const app = rt.app

  const reg = (email: string, ip: string) => app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: 'password123' }),
  })
  const getSecrets = (tok: string) => app.request('/secrets', { headers: { Authorization: `Bearer ${tok}` } })

  // ════════════ 1. REVOCATION ON LOGOUT ════════════
  let tok1 = '', user1Id = ''
  {
    const body = await json(await reg('user1@p1.dev', 'sec-ip-1'))
    tok1 = body.data.accessToken
    user1Id = body.data.user.id

    const before = await getSecrets(tok1)
    check('revocation: valid token works on protected route (200)', before.status === 200, `status=${before.status}`)

    // logout WITH the access token → revokes its jti
    const lo = await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok1}` },
      body: JSON.stringify({}),
    })
    check('revocation: logout 200', lo.status === 200, `status=${lo.status}`)

    const after = await getSecrets(tok1)
    check('revocation: SAME token rejected after logout (401)', after.status === 401, `status=${after.status}`)

    const row = await prisma.revokedToken.findFirst({ where: { jti: { not: null } } })
    check('revocation: jti row persisted in Postgres (RevokedToken)', !!row && !!row.jti, `jti=${row?.jti?.slice(0, 8)}…`)
  }

  // ════════════ 2. USER DELETION CUTS SESSIONS ════════════
  {
    const body = await json(await reg('user2@p1.dev', 'sec-ip-2'))
    const tok2 = body.data.accessToken
    const user2Id = body.data.user.id

    const before = await getSecrets(tok2)
    check('user-delete: token works before deletion (200)', before.status === 200, `status=${before.status}`)

    await rt.deleteSystemResource!('User', user2Id)

    const after = await getSecrets(tok2)
    check('user-delete: token rejected after user deleted (401)', after.status === 401, `status=${after.status}`)

    const gone = await prisma.user.findUnique({ where: { id: user2Id } })
    const cutoff = await prisma.revokedToken.findFirst({ where: { userId: user2Id } })
    check('user-delete: user row gone + per-user cutoff persisted',
      !gone && !!cutoff && !!cutoff.notBefore, `userGone=${!gone} cutoff=${!!cutoff}`)
  }

  // ════════════ 3. NO-SECRET → FAIL CLOSED ════════════
  {
    // A separate runtime with a bearer strategy and NO secret. Previously any
    // 3-segment token was accepted; now it must be refused.
    const noSecretSpec = {
      version: '1.0.0', name: 'no-secret', auth: { strategy: 'bearer' as const },
      resources: [{ name: 'Thing', fields: { v: { type: 'string' as const, required: true } }, auth: { required: true } }],
    }
    const { parseSpec } = await import('../src/index.js')
    const ns = createRuntime(parseSpec(noSecretSpec), { enableLogging: false })
    // A structurally valid (but unverifiable) token.
    const fakeToken = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: '1', role: 'admin' })).toString('base64url'),
      'deadbeef',
    ].join('.')
    const res = await ns.app.request('/things', { headers: { Authorization: `Bearer ${fakeToken}` } })
    check('no-secret: structurally-valid token REFUSED (401, no dangerous fallback)',
      res.status === 401, `status=${res.status}`)
  }

  // ════════════ 4. BRUTE-FORCE RATE LIMIT ON /auth/login ════════════
  {
    const RL_IP = 'brute-force-ip'
    let firstBlockedAt = -1
    let allowed = 0
    for (let i = 1; i <= 25; i++) {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': RL_IP },
        body: JSON.stringify({ email: 'nobody@p1.dev', password: 'wrong' }),
      })
      if (res.status === 429) { if (firstBlockedAt < 0) firstBlockedAt = i }
      else allowed++
    }
    check('rate-limit: brute-force on /auth/login is throttled (429 kicks in)',
      firstBlockedAt > 0, `firstBlockedAt=#${firstBlockedAt} allowed=${allowed}`)
    check('rate-limit: cap honours the 20/window default (≈20 allowed then 429)',
      allowed === 20 && firstBlockedAt === 21, `allowed=${allowed} firstBlockedAt=#${firstBlockedAt}`)
  }

  await prisma.$disconnect()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
