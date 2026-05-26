import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const relSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'relations-routes-test',
  resources: [
    {
      name: 'Author',
      fields: { name: { type: 'string', required: true } },
    },
    {
      name: 'Book',
      fields: { title: { type: 'string', required: true } },
      relations: [
        { type: 'manyToOne', resource: 'Author', field: 'authorId', required: false },
      ],
    },
    {
      name: 'Category',
      fields: { label: { type: 'string', required: true } },
    },
    {
      name: 'Article',
      fields: { headline: { type: 'string', required: true } },
      relations: [
        {
          type: 'manyToMany',
          resource: 'Category',
          through: 'article_categories',
          fields: { position: { type: 'integer' } },
        },
      ],
    },
  ],
}

const { app } = createRuntime(relSpec, { enableLogging: false, enableDocs: false })

describe('Relations in routes', () => {
  let authorId: string
  let bookId: string
  let cat1Id: string
  let articleId: string

  it('creates an Author', async () => {
    const res = await app.request('/authors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jane Austen' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string } }
    authorId = body.data.id
  })

  it('creates a Book with FK authorId', async () => {
    const res = await app.request('/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pride and Prejudice', authorId }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string; authorId: string } }
    bookId = body.data.id
    expect(body.data.authorId).toBe(authorId)
  })

  it('GET /books?include=author resolves manyToOne', async () => {
    const res = await app.request(`/books?include=Author`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ author: { name: string } }> }
    expect(body.data[0]?.author?.name).toBe('Jane Austen')
  })

  it('GET /books/:id?include=author resolves on single item', async () => {
    const res = await app.request(`/books/${bookId}?include=Author`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { author: { name: string } } }
    expect(body.data.author?.name).toBe('Jane Austen')
  })

  it('creates Categories', async () => {
    const res = await app.request('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Fiction' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string } }
    cat1Id = body.data.id
  })

  it('creates Article with nested categories (manyToMany)', async () => {
    const res = await app.request('/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        headline: 'Breaking News',
        categories: [{ categoryId: cat1Id, position: 1 }],
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string } }
    articleId = body.data.id
  })

  it('GET /articles?include=category resolves manyToMany', async () => {
    const res = await app.request('/articles?include=Category')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ category: unknown[] }> }
    expect(Array.isArray(body.data[0]?.category)).toBe(true)
  })

  it('ignores unknown include param gracefully', async () => {
    const res = await app.request('/books?include=nonexistent')
    expect(res.status).toBe(200)
  })

  it('GET /authors?include= with oneToMany resolves books array', async () => {
    // Add oneToMany relation to the spec by creating a new runtime
    const specWithOneToMany: ZeroAPISpec = {
      version: '1.0.0', name: 'one-to-many-test',
      resources: [
        {
          name: 'Writer',
          fields: { name: { type: 'string', required: true } },
          relations: [{ type: 'oneToMany', resource: 'Novel' }],
        },
        {
          name: 'Novel',
          fields: { title: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Writer', field: 'writerId' }],
        },
      ],
    }
    const { app: a } = createRuntime(specWithOneToMany, { enableLogging: false, enableDocs: false })

    const wr = await a.request('/writers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tolkien' }) })
    const { data: { id: wId } } = await wr.json() as { data: { id: string } }

    await a.request('/novels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'LOTR', writerId: wId }) })

    const res = await a.request('/writers?include=Novel')
    const body = await res.json() as { data: Array<{ novel: unknown[] }> }
    expect(Array.isArray(body.data[0]?.novel)).toBe(true)
    expect((body.data[0]?.novel as unknown[]).length).toBeGreaterThan(0)
  })
})

describe('List with filtering and sorting', () => {
  it('GET /books?title[contains]=pride filters correctly', async () => {
    const res = await app.request('/books?title[contains]=pride')
    const body = await res.json() as { data: unknown[]; count: number }
    expect(body.count).toBeGreaterThan(0)
  })

  it('GET /books?sort=title:asc returns sorted list', async () => {
    const res = await app.request('/books?sort=title:asc')
    expect(res.status).toBe(200)
  })

  it('GET /books?limit=1&cursor returns nextCursor', async () => {
    await app.request('/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Emma' }) })
    const res = await app.request('/books?limit=1')
    const body = await res.json() as { nextCursor?: string }
    expect(body.nextCursor).toBeTruthy()
  })
})
