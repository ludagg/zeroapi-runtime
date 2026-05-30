import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRuntime, parseSpec } from '../../src/index.js'
import { generateAccessToken } from '../../src/auth/jwt.js'
import { buildPrismaInclude } from '../../src/relations/prisma-include.js'
import { FakePrismaClient, type FakeRelationMap } from '../store/fake-prisma.js'

const SECRET = 'ownonly-include-secret'
const SAVED = process.env['JWT_SECRET']
afterAll(() => { if (SAVED === undefined) delete process.env['JWT_SECRET']; else process.env['JWT_SECRET'] = SAVED })

// Board 1—N Note, where Note is ownOnly (each user only sees their own notes).
const spec = parseSpec({
  version: '1.0.0',
  name: 'notes',
  auth: { enabled: true, strategies: ['jwt'], jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
  resources: [
    { name: 'Board', fields: { title: { type: 'string', required: true } },
      relations: [{ type: 'oneToMany', resource: 'Note' }] },
    {
      name: 'Note',
      fields: { text: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'Board', field: 'boardId', required: true }],
    },
  ],
  permissions: [
    { resource: 'Board', rules: [{ role: 'user', actions: ['read', 'create'] }] },
    { resource: 'Note', rules: [{ role: 'user', actions: ['read', 'create', 'update', 'delete'], ownOnly: true }] },
  ],
})

const boardResource = spec.resources.find((r) => r.name === 'Board')!
const noteResource = spec.resources.find((r) => r.name === 'Note')!
const relations: FakeRelationMap = {
  board: [{ field: 'notes', target: 'note', kind: 'toMany', fk: 'boardId' }],
}
const token = (userId: string) => generateAccessToken(userId, `${userId}@x.com`, 'user', SECRET, 3600)

describe('Fix 1 — ownOnly on included relations (Prisma mode)', () => {
  it('buildPrismaInclude injects a row-level where for an ownOnly to-many include', () => {
    const built = buildPrismaInclude(boardResource, spec, ['note'], 'user-A')
    expect(built).toEqual({ ok: true, include: { notes: { where: { userId: 'user-A' } } } })
  })

  it('a non-ownOnly include carries no where', () => {
    const built = buildPrismaInclude(noteResource, spec, ['board'], 'user-A')
    expect(built).toEqual({ ok: true, include: { board: true } })
  })

  it('the DB only returns the requester’s own included notes', async () => {
    process.env['JWT_SECRET'] = SECRET
    const db = new FakePrismaClient(['board', 'note'], relations)
    const board = { id: randomUUID(), title: 'shared' }
    db.delegate('board').rows.set(board.id, board)
    db.delegate('note').rows.set('n1', { id: 'n1', text: 'A-note', boardId: board.id, userId: 'user-A' })
    db.delegate('note').rows.set('n2', { id: 'n2', text: 'B-note', boardId: board.id, userId: 'user-B' })

    const { app } = createRuntime(spec, { enableLogging: false, prisma: db as unknown as never })

    const resA = await app.request(`/boards/${board.id}?include=note`, {
      headers: { Authorization: `Bearer ${await token('user-A')}` },
    })
    expect(resA.status).toBe(200)
    const bodyA = await resA.json() as { data: { notes: Array<{ text: string }> } }
    expect(bodyA.data.notes.map((n) => n.text)).toEqual(['A-note'])

    const resB = await app.request(`/boards/${board.id}?include=note`, {
      headers: { Authorization: `Bearer ${await token('user-B')}` },
    })
    const bodyB = await resB.json() as { data: { notes: Array<{ text: string }> } }
    expect(bodyB.data.notes.map((n) => n.text)).toEqual(['B-note'])
  })
})
