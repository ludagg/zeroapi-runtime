import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRuntime, parseSpec, generatePrismaSchema } from '../../src/index.js'
import { buildPrismaInclude, extractM2MFilters } from '../../src/relations/prisma-include.js'
import { FakePrismaClient, type FakeRelationMap } from '../store/fake-prisma.js'

// Person follows Person, with the two directions named.
const spec = parseSpec({
  version: '1.0.0',
  name: 'social',
  resources: [
    {
      name: 'Person',
      fields: { handle: { type: 'string', required: true } },
      relations: [{ type: 'manyToMany', resource: 'Person', through: 'Follows', as: 'following', reverseAs: 'followers' }],
    },
  ],
})
const person = spec.resources.find((r) => r.name === 'Person')!

// Fake relation metadata mirroring the generated schema.
const relations: FakeRelationMap = {
  person: [
    { field: 'following', target: 'follows', kind: 'toMany', fk: 'personId' },
    { field: 'followers', target: 'follows', kind: 'toMany', fk: 'relatedPersonId' },
  ],
  follows: [
    { field: 'relatedPerson', target: 'person', kind: 'toOne', fk: 'relatedPersonId' },
    { field: 'person', target: 'person', kind: 'toOne', fk: 'personId' },
  ],
}

describe('Fix 3 — self-M2M direction (following vs followers)', () => {
  it('schema names the two back-arrays distinctly and stays valid-shaped', () => {
    const schema = generatePrismaSchema(spec)
    const personBlock = schema.slice(schema.indexOf('model Person {'))
    expect(personBlock).toMatch(/following\s+Follows\[\] @relation\("Follows_person"\)/)
    expect(personBlock).toMatch(/followers\s+Follows\[\] @relation\("Follows_relatedPerson"\)/)
  })

  it('buildPrismaInclude maps each direction to the correct far side', () => {
    expect(buildPrismaInclude(person, spec, ['following'])).toEqual({
      ok: true, include: { following: { include: { relatedPerson: true } } },
    })
    expect(buildPrismaInclude(person, spec, ['followers'])).toEqual({
      ok: true, include: { followers: { include: { person: true } } },
    })
  })

  it('extractM2MFilters maps each direction to the correct join FK', () => {
    expect(extractM2MFilters(person, { following: { eq: 'X' } } as never, spec).where)
      .toEqual({ following: { some: { relatedPersonId: 'X' } } })
    expect(extractM2MFilters(person, { followers: { eq: 'Y' } } as never, spec).where)
      .toEqual({ followers: { some: { personId: 'Y' } } })
  })

  it('include returns who I follow vs who follows me (real query)', async () => {
    const db = new FakePrismaClient(['person', 'follows'], relations)
    const { app } = createRuntime(spec, { enableLogging: false, prisma: db as unknown as never })
    const mk = async (handle: string) =>
      (await (await app.request('/persons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle }) })).json() as any).data.id
    const alice = await mk('alice'); const bob = await mk('bob'); const carol = await mk('carol')
    // alice→bob, alice→carol, bob→alice
    db.delegate('follows').rows.set('f1', { personId: alice, relatedPersonId: bob })
    db.delegate('follows').rows.set('f2', { personId: alice, relatedPersonId: carol })
    db.delegate('follows').rows.set('f3', { personId: bob, relatedPersonId: alice })

    const following = await (await app.request(`/persons/${alice}?include=following`)).json() as any
    expect(following.data.following.map((e: any) => e.relatedPerson.handle).sort()).toEqual(['bob', 'carol'])

    const followers = await (await app.request(`/persons/${alice}?include=followers`)).json() as any
    expect(followers.data.followers.map((e: any) => e.person.handle)).toEqual(['bob'])
  })

  it('filters by direction: ?following=<bob> → people who follow bob', async () => {
    const db = new FakePrismaClient(['person', 'follows'], relations)
    const { app } = createRuntime(spec, { enableLogging: false, prisma: db as unknown as never })
    const mk = async (handle: string) =>
      (await (await app.request('/persons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle }) })).json() as any).data.id
    const alice = await mk('alice'); const bob = await mk('bob')
    db.delegate('follows').rows.set('f1', { personId: alice, relatedPersonId: bob })

    const res = await app.request(`/persons?following=${bob}`)
    const body = await res.json() as { data: Array<{ handle: string }> }
    expect(body.data.map((p) => p.handle)).toEqual(['alice'])
  })
})
