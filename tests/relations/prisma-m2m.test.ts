import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRuntime, parseSpec } from '../../src/index.js'
import { FakePrismaClient, type FakeRelationMap } from '../store/fake-prisma.js'

// ── Post N—N Hashtag (synthetic join PostHashtags) ─────────────────────────────
const spec = parseSpec({
  version: '1.0.0',
  name: 'blog',
  resources: [
    {
      name: 'Post',
      fields: { title: { type: 'string', required: true } },
      relations: [{ type: 'manyToMany', resource: 'Hashtag', through: 'PostHashtags' }],
    },
    { name: 'Hashtag', fields: { label: { type: 'string', required: true } } },
  ],
})

const relations: FakeRelationMap = {
  post: [{ field: 'postHashtags', target: 'postHashtags', kind: 'toMany', fk: 'postId' }],
  postHashtags: [{ field: 'hashtag', target: 'hashtag', kind: 'toOne', fk: 'hashtagId' }],
}

describe('Prisma-mode many-to-many filtering', () => {
  it('filters posts by a related hashtag (?hashtag=<id>)', async () => {
    const db = new FakePrismaClient(['post', 'hashtag', 'postHashtags'], relations)
    const tech = { id: randomUUID(), label: 'tech' }
    const food = { id: randomUUID(), label: 'food' }
    db.delegate('hashtag').rows.set(tech.id, tech)
    db.delegate('hashtag').rows.set(food.id, food)

    const p1 = { id: randomUUID(), title: 'About Rust' }
    const p2 = { id: randomUUID(), title: 'About Pasta' }
    db.delegate('post').rows.set(p1.id, p1)
    db.delegate('post').rows.set(p2.id, p2)
    db.delegate('postHashtags').rows.set('j1', { id: 'j1', postId: p1.id, hashtagId: tech.id })
    db.delegate('postHashtags').rows.set('j2', { id: 'j2', postId: p2.id, hashtagId: food.id })

    const { app } = createRuntime(spec, { enableLogging: false, prisma: db as unknown as never })

    const res = await app.request(`/posts?hashtag=${tech.id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ title: string }>; count: number }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]!.title).toBe('About Rust')
  })

  it('combines a M2M filter with a scalar filter', async () => {
    const db = new FakePrismaClient(['post', 'hashtag', 'postHashtags'], relations)
    const tech = { id: randomUUID(), label: 'tech' }
    db.delegate('hashtag').rows.set(tech.id, tech)
    const p1 = { id: randomUUID(), title: 'keep' }
    const p2 = { id: randomUUID(), title: 'drop' }
    db.delegate('post').rows.set(p1.id, p1)
    db.delegate('post').rows.set(p2.id, p2)
    db.delegate('postHashtags').rows.set('j1', { id: 'j1', postId: p1.id, hashtagId: tech.id })
    db.delegate('postHashtags').rows.set('j2', { id: 'j2', postId: p2.id, hashtagId: tech.id })

    const { app } = createRuntime(spec, { enableLogging: false, prisma: db as unknown as never })

    // Both posts carry the hashtag; the scalar title filter narrows to one.
    const res = await app.request(`/posts?hashtag=${tech.id}&title=keep`)
    const body = await res.json() as { data: Array<{ title: string }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]!.title).toBe('keep')
  })
})

// ── Self many-to-many (Person follows Person) — query works in Prisma mode ─────
describe('Prisma-mode self many-to-many query', () => {
  const followSpec = parseSpec({
    version: '1.0.0',
    name: 'social',
    resources: [
      {
        name: 'Person',
        fields: { handle: { type: 'string', required: true } },
        relations: [{ type: 'manyToMany', resource: 'Person', through: 'Follows' }],
      },
    ],
  })

  it('lists and reads persons backed by Prisma (self-M2M schema is valid)', async () => {
    const db = new FakePrismaClient(['person', 'follows'])
    const alice = { id: randomUUID(), handle: 'alice' }
    const bob = { id: randomUUID(), handle: 'bob' }
    db.delegate('person').rows.set(alice.id, alice)
    db.delegate('person').rows.set(bob.id, bob)
    // A follow edge alice → bob lives in the join table with two distinct FKs.
    db.delegate('follows').rows.set('f1', { personId: alice.id, relatedPersonId: bob.id })

    const { app } = createRuntime(followSpec, { enableLogging: false, prisma: db as unknown as never })

    const list = await app.request('/persons')
    expect(list.status).toBe(200)
    const body = await list.json() as { data: Array<{ handle: string }>; count: number }
    expect(body.data.map((p) => p.handle).sort()).toEqual(['alice', 'bob'])

    const read = await app.request(`/persons/${alice.id}`)
    expect(read.status).toBe(200)
    expect((await read.json() as { data: { handle: string } }).data.handle).toBe('alice')
  })
})
