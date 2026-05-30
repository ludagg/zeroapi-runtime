import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRuntime, parseSpec, generatePrismaSchema } from '../../src/index.js'
import { buildPrismaInclude } from '../../src/relations/prisma-include.js'
import { FakePrismaClient, type FakeRelationMap } from '../store/fake-prisma.js'

// ── blog spec: Author 1—N Comment, Post 1—N Comment, Post N—N Hashtag ──────────
const blogSpec = parseSpec({
  version: '1.0.0',
  name: 'blog',
  resources: [
    { name: 'Author', fields: { name: { type: 'string', required: true } } },
    {
      name: 'Post',
      fields: { title: { type: 'string', required: true } },
      relations: [
        { type: 'oneToMany', resource: 'Comment' },
        { type: 'manyToMany', resource: 'Hashtag', through: 'PostHashtags' },
      ],
    },
    {
      name: 'Comment',
      fields: { text: { type: 'string', required: true } },
      relations: [
        { type: 'manyToOne', resource: 'Post', field: 'postId', required: true },
        { type: 'manyToOne', resource: 'Author', field: 'authorId', required: true },
      ],
    },
    { name: 'Hashtag', fields: { label: { type: 'string', required: true } } },
  ],
})

const postResource = blogSpec.resources.find((r) => r.name === 'Post')!

// ─────────────────────────────────────────────────────────────────────────────
// buildPrismaInclude — pure function, verified WITHOUT any fake.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPrismaInclude — ?include= → native Prisma include tree', () => {
  it('maps a oneToMany to its pluralised back-array field', () => {
    const built = buildPrismaInclude(postResource, blogSpec, ['comment'])
    expect(built).toEqual({ ok: true, include: { comments: true } })
  })

  it('builds a NESTED include of any depth (comment.author)', () => {
    const built = buildPrismaInclude(postResource, blogSpec, ['comment.author'])
    expect(built).toEqual({
      ok: true,
      include: { comments: { include: { author: true } } },
    })
  })

  it('routes a manyToMany include through its join model', () => {
    const built = buildPrismaInclude(postResource, blogSpec, ['hashtag'])
    expect(built).toEqual({
      ok: true,
      include: { postHashtags: { include: { hashtag: true } } },
    })
  })

  it('merges multiple include paths into one tree', () => {
    const built = buildPrismaInclude(postResource, blogSpec, ['comment.author', 'hashtag'])
    expect(built).toEqual({
      ok: true,
      include: {
        comments: { include: { author: true } },
        postHashtags: { include: { hashtag: true } },
      },
    })
  })

  it('rejects an unknown relation segment', () => {
    expect(buildPrismaInclude(postResource, blogSpec, ['comment.nope'])).toEqual({
      ok: false,
      unknown: 'nope',
    })
  })

  // Strongest, fake-independent check: every field name the builder emits MUST
  // exist as a relation field in the actually-generated (prisma-valid) schema,
  // or real Prisma would reject the include at query time.
  it('emits field names that exist in the generated Prisma schema', () => {
    const schema = generatePrismaSchema(blogSpec)
    const postBlock = schema.slice(schema.indexOf('model Post {'))
    expect(postBlock).toMatch(/\bcomments\s+Comment\[\]/)
    expect(postBlock).toMatch(/\bpostHashtags\s+PostHashtags\[\]/)
    const commentBlock = schema.slice(schema.indexOf('model Comment {'))
    expect(commentBlock).toMatch(/\bauthor\s+Author\b/)
    const joinBlock = schema.slice(schema.indexOf('model PostHashtags {'))
    expect(joinBlock).toMatch(/\bhashtag\s+Hashtag\b/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Runtime — Prisma mode resolves includes natively (nested + M2M) in one call.
// ─────────────────────────────────────────────────────────────────────────────

const blogRelations: FakeRelationMap = {
  post: [
    { field: 'comments', target: 'comment', kind: 'toMany', fk: 'postId' },
    { field: 'postHashtags', target: 'postHashtags', kind: 'toMany', fk: 'postId' },
  ],
  comment: [{ field: 'author', target: 'author', kind: 'toOne', fk: 'authorId' }],
  postHashtags: [{ field: 'hashtag', target: 'hashtag', kind: 'toOne', fk: 'hashtagId' }],
}

function makeBlogDb() {
  const db = new FakePrismaClient(['author', 'post', 'comment', 'hashtag', 'postHashtags'], blogRelations)
  const author = { id: randomUUID(), name: 'Ada' }
  const post = { id: randomUUID(), title: 'Hello' }
  db.delegate('author').rows.set(author.id, author)
  db.delegate('post').rows.set(post.id, post)
  for (const text of ['first', 'second']) {
    const c = { id: randomUUID(), text, postId: post.id, authorId: author.id }
    db.delegate('comment').rows.set(c.id, c)
  }
  const hashtag = { id: randomUUID(), label: 'intro' }
  db.delegate('hashtag').rows.set(hashtag.id, hashtag)
  db.delegate('postHashtags').rows.set('j1', { id: 'j1', postId: post.id, hashtagId: hashtag.id })
  return { db, post, author, hashtag }
}

describe('Prisma-mode native includes', () => {
  it('returns Post + Comments + Authors nested in a SINGLE request', async () => {
    const { db, post, author } = makeBlogDb()
    const { app } = createRuntime(blogSpec, { enableLogging: false, prisma: db as unknown as never })

    const res = await app.request(`/posts/${post.id}?include=comment.author`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      data: { title: string; comments: Array<{ text: string; author: { name: string } }> }
    }
    expect(body.data.title).toBe('Hello')
    expect(body.data.comments).toHaveLength(2)
    // depth > 1: each comment carries its author object.
    for (const c of body.data.comments) {
      expect(c.author.name).toBe(author.name)
    }
  })

  it('resolves a many-to-many include through the join model', async () => {
    const { db, post, hashtag } = makeBlogDb()
    const { app } = createRuntime(blogSpec, { enableLogging: false, prisma: db as unknown as never })

    const res = await app.request(`/posts/${post.id}?include=hashtag`)
    const body = await res.json() as {
      data: { postHashtags: Array<{ hashtag: { label: string } }> }
    }
    expect(body.data.postHashtags).toHaveLength(1)
    expect(body.data.postHashtags[0]!.hashtag.label).toBe(hashtag.label)
  })

  it('list endpoint nests relations too', async () => {
    const { db, author } = makeBlogDb()
    const { app } = createRuntime(blogSpec, { enableLogging: false, prisma: db as unknown as never })

    const res = await app.request('/posts?include=comment.author')
    const body = await res.json() as {
      data: Array<{ comments: Array<{ author: { name: string } }> }>
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]!.comments[0]!.author.name).toBe(author.name)
  })

  it('400s on an unknown nested relation', async () => {
    const { db, post } = makeBlogDb()
    const { app } = createRuntime(blogSpec, { enableLogging: false, prisma: db as unknown as never })
    const res = await app.request(`/posts/${post.id}?include=comment.bogus`)
    expect(res.status).toBe(400)
  })
})
