/**
 * Phase 1 Auth — e2e validation runner.
 *
 * Spawns server.ts as a child process, parses its READY line for the
 * bootstrap key + pre-issued JWTs, then drives 17 scenarios with real HTTP
 * calls and prints a Markdown results table + raw response details.
 *
 * Usage:  npx tsx phase1-e2e/validate.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { setTimeout as wait } from 'timers/promises'

interface ServerMeta {
  port: number
  bootstrapKey: string
  adminToken: string
  vendorAToken: string
  vendorBToken: string
  adminId: string
  vendorAId: string
  vendorBId: string
}

interface Scenario {
  num: number
  desc: string
  expected: string
  got: string
  pass: boolean
  notes?: string
}

const results: Scenario[] = []
let captured = { jwt: { accessToken: '', refreshToken: '' } }
let vendorAProductId = ''

async function startServer(): Promise<{ proc: ChildProcessWithoutNullStreams; meta: ServerMeta }> {
  const proc = spawn('node_modules/.bin/tsx', ['phase1-e2e/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3031' },
  })
  proc.stderr.on('data', (d) => process.stderr.write('[server.stderr] ' + d.toString()))

  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (d: Buffer) => {
      buf += d.toString()
      const m = buf.match(/^READY (.+)$/m)
      if (m) {
        proc.stdout.off('data', onData)
        const meta = JSON.parse(m[1]) as ServerMeta
        resolve({ proc, meta })
      }
    }
    proc.stdout.on('data', onData)
    proc.on('exit', (code) => reject(new Error(`server exited early (code ${code})`)))
    setTimeout(() => reject(new Error('server did not become ready within 10s')), 10000)
  })
}

interface HttpResponse {
  status: number
  body: unknown
  raw: string
}

async function http(
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(base + path, { method, headers, body })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* keep raw text */ }
  return { status: res.status, body: parsed, raw: text }
}

function record(num: number, desc: string, expected: string, got: string, pass: boolean, notes?: string) {
  results.push({ num, desc, expected, got, pass, ...(notes ? { notes } : {}) })
  const status = pass ? '✅' : '❌'
  console.log(`  ${status} #${num}  ${desc}`)
  console.log(`        expected: ${expected}`)
  console.log(`        got     : ${got}`)
  if (notes) console.log(`        note    : ${notes}`)
}

async function main(): Promise<void> {
  console.log('Starting server…')
  const { proc, meta } = await startServer()
  const base = `http://127.0.0.1:${meta.port}`
  console.log(`Server ready on ${base}`)
  console.log(`Bootstrap key  : ${meta.bootstrapKey}`)
  console.log(`Admin token    : ${meta.adminToken.slice(0, 30)}…`)
  console.log(`Vendor A token : ${meta.vendorAToken.slice(0, 30)}…`)
  console.log(`Vendor B token : ${meta.vendorBToken.slice(0, 30)}…`)
  console.log()

  try {
    // ── A. JWT auth flow ──
    console.log('A. AUTH JWT')

    // #1 register
    {
      const res = await http(base, 'POST', '/auth/register', {
        body: { email: 'alice@shop.test', password: 'correcthorse' },
      })
      const data = (res.body as any)?.data ?? {}
      const ok = res.status === 201
        && typeof data.accessToken === 'string'
        && typeof data.refreshToken === 'string'
        && typeof data.user?.id === 'string'
      record(1, 'register a user', '201 + access + refresh + user',
        `${res.status} accessToken=${!!data.accessToken} refreshToken=${!!data.refreshToken}`, ok)
    }

    // #2 login
    {
      const res = await http(base, 'POST', '/auth/login', {
        body: { email: 'alice@shop.test', password: 'correcthorse' },
      })
      const data = (res.body as any)?.data ?? {}
      const ok = res.status === 200
        && typeof data.accessToken === 'string'
        && typeof data.refreshToken === 'string'
      if (ok) {
        captured.jwt.accessToken = data.accessToken
        captured.jwt.refreshToken = data.refreshToken
      }
      record(2, 'login', '200 + access + refresh',
        `${res.status} accessToken=${!!data.accessToken} refreshToken=${!!data.refreshToken}`, ok)
    }

    // #3 /auth/me valid
    {
      const res = await http(base, 'GET', '/auth/me', {
        headers: { Authorization: `Bearer ${captured.jwt.accessToken}` },
      })
      const data = (res.body as any)?.data?.user ?? {}
      const ok = res.status === 200 && data.email === 'alice@shop.test'
      record(3, '/auth/me with valid token', '200 + user.email matches',
        `${res.status} email=${data.email ?? '(missing)'}`, ok)
    }

    // #4 /auth/me invalid
    {
      const res = await http(base, 'GET', '/auth/me', {
        headers: { Authorization: 'Bearer not.a.real.jwt' },
      })
      record(4, '/auth/me with invalid token', '401',
        `${res.status}`, res.status === 401)
    }

    // #5 refresh — issued back-to-back; the jti claim guarantees the new
    // access token is byte-different even when iat is unchanged.
    let refreshedAccess = ''
    let rotatedRefresh = ''
    {
      const res = await http(base, 'POST', '/auth/refresh', {
        body: { refreshToken: captured.jwt.refreshToken },
      })
      const data = (res.body as any)?.data ?? {}
      const ok = res.status === 200
        && typeof data.accessToken === 'string'
        && typeof data.refreshToken === 'string'
        && data.accessToken !== captured.jwt.accessToken
      if (ok) {
        refreshedAccess = data.accessToken
        rotatedRefresh = data.refreshToken
      }
      record(5, 'refresh → new access token', '200 + new accessToken ≠ old',
        `${res.status} newAccess=${!!data.accessToken} different=${data.accessToken !== captured.jwt.accessToken}`, ok)
    }

    // #6 logout
    {
      const res = await http(base, 'POST', '/auth/logout', {
        body: { refreshToken: rotatedRefresh || captured.jwt.refreshToken },
      })
      record(6, 'logout → refresh revoked', '200',
        `${res.status}`, res.status === 200)
    }

    // #7 refresh after logout
    {
      const res = await http(base, 'POST', '/auth/refresh', {
        body: { refreshToken: rotatedRefresh || captured.jwt.refreshToken },
      })
      record(7, 'refresh after logout', '401',
        `${res.status}`, res.status === 401)
    }

    // ── B. RBAC ──
    console.log('\nB. RBAC')

    // #8 GET /products no auth (public read)
    {
      const res = await http(base, 'GET', '/products')
      record(8, 'GET /products without auth (public read)', '200',
        `${res.status}`, res.status === 200)
    }

    // #9 POST /products no auth
    {
      const res = await http(base, 'POST', '/products', { body: { title: 'noauth' } })
      record(9, 'POST /products without auth', '401',
        `${res.status}`, res.status === 401)
    }

    // #10 POST /products with default user role (alice)
    {
      // Re-login alice to get a fresh access token (the original refresh was revoked, access still valid).
      const login = await http(base, 'POST', '/auth/login', {
        body: { email: 'alice@shop.test', password: 'correcthorse' },
      })
      const userToken = (login.body as any)?.data?.accessToken as string
      const res = await http(base, 'POST', '/products', {
        body: { title: 'from-user' },
        headers: { Authorization: `Bearer ${userToken}` },
      })
      record(10, 'POST /products with role=user', '403',
        `${res.status}`, res.status === 403,
        `Reason: no rule grants 'create' to role 'user' on Product`)
    }

    // #11 POST /products with admin
    {
      const res = await http(base, 'POST', '/products', {
        body: { title: 'Admin Phone', price: 999 },
        headers: { Authorization: `Bearer ${meta.adminToken}` },
      })
      record(11, 'POST /products with role=admin', '201',
        `${res.status}`, res.status === 201)
    }

    // #12 vendor creates a product, userId forced
    {
      const res = await http(base, 'POST', '/products', {
        body: { title: 'Vendor-A Lamp', userId: meta.vendorBId },
        headers: { Authorization: `Bearer ${meta.vendorAToken}` },
      })
      const data = (res.body as any)?.data ?? {}
      const ok = res.status === 201 && data.userId === meta.vendorAId
      if (ok) vendorAProductId = data.id
      record(12, 'vendor POST /products → userId forced to JWT sub',
        '201 + userId == vendorA.id (body userId ignored)',
        `${res.status} userId=${data.userId ?? '(missing)'} expected=${meta.vendorAId}`, ok)
    }

    // #13 vendor B reads vendor A's product → 404
    {
      const res = await http(base, 'GET', `/products/${vendorAProductId}`, {
        headers: { Authorization: `Bearer ${meta.vendorBToken}` },
      })
      record(13, 'vendor B reads vendor A’s product', '404 (ownership hides existence)',
        `${res.status}`, res.status === 404)
    }

    // ── C. API keys ──
    console.log('\nC. API KEYS')

    // #14 GET /admin/api-keys with bootstrap key
    {
      const res = await http(base, 'GET', '/admin/api-keys', {
        headers: { 'x-api-key': meta.bootstrapKey },
      })
      const data = (res.body as any)?.data
      const ok = res.status === 200 && Array.isArray(data) && data.length >= 1
      record(14, 'GET /admin/api-keys with bootstrap key', '200 + array',
        `${res.status} len=${Array.isArray(data) ? data.length : '(not array)'}`, ok)
    }

    // #15 POST /admin/api-keys
    let createdKey = ''
    let createdKeyId = ''
    {
      const res = await http(base, 'POST', '/admin/api-keys', {
        body: { name: 'test-key', role: 'admin' },
        headers: { 'x-api-key': meta.bootstrapKey },
      })
      const data = (res.body as any)?.data ?? {}
      const ok = res.status === 201 && typeof data.key === 'string' && typeof data.id === 'string'
      if (ok) { createdKey = data.key; createdKeyId = data.id }
      record(15, 'POST /admin/api-keys', '201 + new key returned',
        `${res.status} keyPrefix=${data.keyPrefix ?? '(missing)'}`, ok)
    }

    // #16 request with revoked key
    {
      // Use the bootstrap key to revoke the key we just created.
      const del = await http(base, 'DELETE', `/admin/api-keys/${createdKeyId}`, {
        headers: { 'x-api-key': meta.bootstrapKey },
      })
      const revokedOk = del.status === 200

      const res = await http(base, 'GET', '/admin/api-keys', {
        headers: { 'x-api-key': createdKey },
      })
      record(16, 'request with revoked key', '401',
        `revokedDelete=${del.status} authRequest=${res.status}`, revokedOk && res.status === 401)
    }

    // #17 request with bogus key
    {
      const res = await http(base, 'GET', '/admin/api-keys', {
        headers: { 'x-api-key': 'zak_live_bogusbogusbogusbogusbogusbogusbogusbogusbogusbogusbogusbogu' },
      })
      record(17, 'request with bogus API key', '401',
        `${res.status}`, res.status === 401)
    }
  } finally {
    proc.kill()
    await wait(200)
  }

  // ── Report ─────────────────────────────────────────────────────────
  console.log('\n')
  console.log('============================================================')
  console.log('  Phase 1 Auth — End-to-end Validation Report')
  console.log('============================================================\n')
  console.log('| #  | Scénario | Attendu | Obtenu | Statut |')
  console.log('|----|----------|---------|--------|--------|')
  for (const r of results) {
    const e = r.expected.replace(/\|/g, '\\|')
    const g = r.got.replace(/\|/g, '\\|')
    const d = r.desc.replace(/\|/g, '\\|')
    console.log(`| ${r.num} | ${d} | ${e} | ${g} | ${r.pass ? '✅' : '❌'} |`)
  }

  const failed = results.filter((r) => !r.pass)
  console.log()
  console.log(`Total: ${results.length}    Passed: ${results.length - failed.length}    Failed: ${failed.length}`)
  if (failed.length === 0) {
    console.log('\n✅ Phase 1 Auth est VALIDÉE — tous les scénarios passent.')
  } else {
    console.log('\n❌ Échecs:')
    for (const f of failed) {
      console.log(`  #${f.num}  ${f.desc}`)
      console.log(`     attendu: ${f.expected}`)
      console.log(`     obtenu : ${f.got}`)
      if (f.notes) console.log(`     note   : ${f.notes}`)
    }
  }

  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Validation runner crashed:', err)
  process.exit(2)
})
