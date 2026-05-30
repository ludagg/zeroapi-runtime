import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRuntime, parseSpec, ParseError } from '../../src/index.js'
import { generateAccessToken } from '../../src/auth/jwt.js'
import { checkTransition } from '../../src/state/state-machine.js'
import { FakePrismaClient } from '../store/fake-prisma.js'
import type { StateMachineDef } from '../../src/types/spec.js'

const SECRET = 'state-machine-secret'
const SAVED = process.env['JWT_SECRET']
beforeAll(() => { process.env['JWT_SECRET'] = SECRET })
afterAll(() => { if (SAVED === undefined) delete process.env['JWT_SECRET']; else process.env['JWT_SECRET'] = SAVED })

const sm: StateMachineDef = {
  field: 'status',
  initial: 'draft',
  transitions: [
    { from: 'draft', to: 'published', roles: ['editor', 'admin'] },
    { from: 'published', to: 'archived', roles: ['admin'] },
    { from: 'archived', to: 'draft', roles: ['admin'] },
  ],
}

// ── pure helper ───────────────────────────────────────────────────────────────
describe('checkTransition (pure)', () => {
  it('allows a no-op (from === to)', () => {
    expect(checkTransition(sm, 'draft', 'draft', 'viewer')).toEqual({ ok: true })
  })
  it('allows a listed transition for an allowed role', () => {
    expect(checkTransition(sm, 'draft', 'published', 'editor')).toEqual({ ok: true })
  })
  it('rejects an unlisted transition with 409', () => {
    const r = checkTransition(sm, 'draft', 'archived', 'admin')
    expect(r.ok).toBe(false)
    expect((r as { status: number }).status).toBe(409)
  })
  it('rejects a listed transition for a disallowed role with 403', () => {
    const r = checkTransition(sm, 'published', 'archived', 'editor')
    expect(r.ok).toBe(false)
    expect((r as { status: number }).status).toBe(403)
  })
})

// ── parser validation ───────────────────────────────────────────────────────
describe('stateMachine parser validation', () => {
  const base = (overrides: Record<string, unknown>) => ({
    version: '1.0.0', name: 's',
    resources: [{
      name: 'Post',
      fields: { status: { type: 'enum', values: ['draft', 'published'] }, title: { type: 'string', required: true } },
      ...overrides,
    }],
  })
  it('rejects a stateMachine on a non-enum field', () => {
    expect(() => parseSpec(base({ stateMachine: { field: 'title', initial: 'draft', transitions: [{ from: 'draft', to: 'published' }] } }))).toThrow(ParseError)
  })
  it('rejects an unknown field', () => {
    expect(() => parseSpec(base({ stateMachine: { field: 'nope', initial: 'draft', transitions: [{ from: 'draft', to: 'published' }] } }))).toThrow(/unknown field/i)
  })
  it('rejects initial not in the enum values', () => {
    expect(() => parseSpec(base({ stateMachine: { field: 'status', initial: 'nope', transitions: [{ from: 'draft', to: 'published' }] } }))).toThrow(/initial/i)
  })
  it('rejects from/to not in the enum values', () => {
    expect(() => parseSpec(base({ stateMachine: { field: 'status', initial: 'draft', transitions: [{ from: 'draft', to: 'nope' }] } }))).toThrow(/transition\.to/i)
  })
  it('accepts a valid state machine', () => {
    expect(() => parseSpec(base({ stateMachine: { field: 'status', initial: 'draft', transitions: [{ from: 'draft', to: 'published' }] } }))).not.toThrow()
  })
})

// ── runtime (both modes) ──────────────────────────────────────────────────────
const spec = parseSpec({
  version: '1.0.0',
  name: 'blog',
  auth: { enabled: true, strategies: ['jwt'], jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
  resources: [{
    name: 'Post',
    fields: {
      title: { type: 'string', required: true },
      status: { type: 'enum', values: ['draft', 'published', 'archived'], default: 'draft' },
    },
    stateMachine: sm,
  }],
  permissions: [{
    resource: 'Post',
    rules: [
      { role: 'editor', actions: ['create', 'read', 'update'] },
      { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
    ],
  }],
})

const token = (role: string) => generateAccessToken(`${role}-1`, `${role}@x.com`, role, SECRET, 3600)

for (const mode of ['memory', 'prisma'] as const) {
  describe(`state machine runtime (${mode} mode)`, () => {
    function makeApp() {
      if (mode === 'prisma') {
        const db = new FakePrismaClient(['post'])
        return createRuntime(spec, { enableLogging: false, prisma: db as unknown as never }).app
      }
      return createRuntime(spec, { enableLogging: false }).app
    }
    const create = async (app: ReturnType<typeof makeApp>, role: string, body: Record<string, unknown>) =>
      app.request('/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(role)}` }, body: JSON.stringify(body) })
    const put = async (app: ReturnType<typeof makeApp>, role: string, id: string, body: Record<string, unknown>) =>
      app.request(`/posts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(role)}` }, body: JSON.stringify(body) })

    it('create forces status to `initial` (ignores a later state in the body)', async () => {
      const app = makeApp()
      const res = await create(app, 'editor', { title: 'P', status: 'published' })
      expect(res.status).toBe(201)
      expect((await res.json() as { data: { status: string } }).data.status).toBe('draft')
    })

    it('valid transition + allowed role → 200', async () => {
      const app = makeApp()
      const id = (await (await create(app, 'editor', { title: 'P' })).json() as { data: { id: string } }).data.id
      const res = await put(app, 'editor', id, { status: 'published' })
      expect(res.status).toBe(200)
      expect((await res.json() as { data: { status: string } }).data.status).toBe('published')
    })

    it('unlisted transition (draft→archived) → 409', async () => {
      const app = makeApp()
      const id = (await (await create(app, 'admin', { title: 'P' })).json() as { data: { id: string } }).data.id
      const res = await put(app, 'admin', id, { status: 'archived' })
      expect(res.status).toBe(409)
    })

    it('listed transition but wrong role (editor: published→archived) → 403', async () => {
      const app = makeApp()
      const id = (await (await create(app, 'editor', { title: 'P' })).json() as { data: { id: string } }).data.id
      await put(app, 'editor', id, { status: 'published' }) // draft→published OK
      const res = await put(app, 'editor', id, { status: 'archived' }) // needs admin
      expect(res.status).toBe(403)
    })

    it('admin can do the admin-only transition (published→archived) → 200', async () => {
      const app = makeApp()
      const id = (await (await create(app, 'admin', { title: 'P' })).json() as { data: { id: string } }).data.id
      await put(app, 'admin', id, { status: 'published' })
      const res = await put(app, 'admin', id, { status: 'archived' })
      expect(res.status).toBe(200)
      expect((await res.json() as { data: { status: string } }).data.status).toBe('archived')
    })

    it('update that does not touch the state field is unconstrained', async () => {
      const app = makeApp()
      const id = (await (await create(app, 'editor', { title: 'P' })).json() as { data: { id: string } }).data.id
      const res = await put(app, 'editor', id, { title: 'renamed' })
      expect(res.status).toBe(200)
      const body = await res.json() as { data: { title: string; status: string } }
      expect(body.data.title).toBe('renamed')
      expect(body.data.status).toBe('draft')
    })
  })
}
