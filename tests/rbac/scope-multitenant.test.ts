import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sign } from 'hono/jwt'
import { createRuntime, parseSpec } from '../../src/index.js'
import { FakePrismaClient } from '../store/fake-prisma.js'

const SECRET = 'scope-multitenant-secret'
const SAVED = process.env['JWT_SECRET']
beforeAll(() => { process.env['JWT_SECRET'] = SECRET })
afterAll(() => { if (SAVED === undefined) delete process.env['JWT_SECRET']; else process.env['JWT_SECRET'] = SAVED })

const spec = parseSpec({
  version: '1.0.0',
  name: 'b2b',
  auth: { enabled: true, strategies: ['jwt'], jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
  resources: [
    {
      name: 'Document',
      fields: {
        title: { type: 'string', required: true },
        // server-managed tenant column, forced from the JWT 'org' claim
        organizationId: { type: 'string', required: false },
      },
    },
  ],
  permissions: [
    {
      resource: 'Document',
      rules: [
        { role: 'member', actions: ['create', 'read', 'update', 'delete'], scope: { column: 'organizationId', claim: 'org' } },
      ],
    },
  ],
})

// JWT carrying a custom `org` claim (generateAccessToken only sets sub/role).
const token = (userId: string, org: string) =>
  sign({ sub: userId, role: 'member', org, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET, 'HS256')

// Run the whole B2B suite in BOTH modes.
for (const mode of ['memory', 'prisma'] as const) {
  describe(`multi-tenant scope (${mode} mode)`, () => {
    function makeApp() {
      if (mode === 'prisma') {
        const db = new FakePrismaClient(['document'])
        return createRuntime(spec, { enableLogging: false, prisma: db as unknown as never }).app
      }
      return createRuntime(spec, { enableLogging: false }).app
    }

    async function createDoc(app: ReturnType<typeof makeApp>, userId: string, org: string, title: string, bodyOrg?: string) {
      const body: Record<string, unknown> = { title }
      if (bodyOrg !== undefined) body['organizationId'] = bodyOrg
      const res = await app.request('/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(userId, org)}` },
        body: JSON.stringify(body),
      })
      return res
    }
    const listDocs = async (app: ReturnType<typeof makeApp>, userId: string, org: string) =>
      (await (await app.request('/documents', { headers: { Authorization: `Bearer ${await token(userId, org)}` } })).json()) as { data: Array<{ title: string; organizationId: string }> }

    it('create forces organizationId to the requester’s org (cannot write into another org)', async () => {
      const app = makeApp()
      // Alice (org-A) maliciously sends organizationId=org-B in the body.
      const res = await createDoc(app, 'alice', 'org-A', 'A-secret', 'org-B')
      expect(res.status).toBe(201)
      const body = await res.json() as { data: { organizationId: string } }
      expect(body.data.organizationId).toBe('org-A') // forced, not org-B
    })

    it('isolation: a member of org A never sees org B’s rows', async () => {
      const app = makeApp()
      await createDoc(app, 'alice', 'org-A', 'A1')
      await createDoc(app, 'alice', 'org-A', 'A2')
      await createDoc(app, 'bob', 'org-B', 'B1')

      const aList = await listDocs(app, 'alice', 'org-A')
      expect(aList.data.map((d) => d.title).sort()).toEqual(['A1', 'A2'])
      const bList = await listDocs(app, 'bob', 'org-B')
      expect(bList.data.map((d) => d.title)).toEqual(['B1'])
    })

    it('members of the SAME org share rows', async () => {
      const app = makeApp()
      await createDoc(app, 'alice', 'org-A', 'shared')
      // A different user, same org → sees Alice's row.
      const list = await listDocs(app, 'alice2', 'org-A')
      expect(list.data.map((d) => d.title)).toEqual(['shared'])
    })

    it('reading another org’s row by id returns 404 (existence not leaked)', async () => {
      const app = makeApp()
      const created = await (await createDoc(app, 'bob', 'org-B', 'B-only')).json() as { data: { id: string } }
      const res = await app.request(`/documents/${created.data.id}`, {
        headers: { Authorization: `Bearer ${await token('alice', 'org-A')}` },
      })
      expect(res.status).toBe(404)
    })

    it('update/delete cannot touch another org’s row (404)', async () => {
      const app = makeApp()
      const created = await (await createDoc(app, 'bob', 'org-B', 'B-doc')).json() as { data: { id: string } }
      const upd = await app.request(`/documents/${created.data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token('alice', 'org-A')}` },
        body: JSON.stringify({ title: 'hacked' }),
      })
      expect(upd.status).toBe(404)
      const del = await app.request(`/documents/${created.data.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await token('alice', 'org-A')}` },
      })
      expect(del.status).toBe(404)
    })

    it('a JWT missing the scope claim is forbidden (403)', async () => {
      const app = makeApp()
      const noOrg = await sign({ sub: 'x', role: 'member', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET, 'HS256')
      const res = await app.request('/documents', { headers: { Authorization: `Bearer ${noOrg}` } })
      expect(res.status).toBe(403)
    })
  })
}
