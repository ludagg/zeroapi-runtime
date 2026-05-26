import { describe, it, expect } from 'vitest'
import { toPlural } from '../../src/utils/plural.js'
import { createRuntime } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

// ── Unit: toPlural rules ───────────────────────────────────────────────────────

describe('toPlural — unit', () => {
  it('appends -s for regular nouns', () => {
    expect(toPlural('book')).toBe('books')
    expect(toPlural('author')).toBe('authors')
    expect(toPlural('novel')).toBe('novels')
  })

  it('applies y→ies for nouns ending in -y', () => {
    expect(toPlural('category')).toBe('categories')
    expect(toPlural('company')).toBe('companies')
    expect(toPlural('library')).toBe('libraries')
    expect(toPlural('country')).toBe('countries')
  })

  it('leaves nouns already ending in -s unchanged', () => {
    expect(toPlural('status')).toBe('status')
    expect(toPlural('address')).toBe('address')
    expect(toPlural('class')).toBe('class')
  })

  it('is case-insensitive and always returns lowercase', () => {
    expect(toPlural('Category')).toBe('categories')
    expect(toPlural('Company')).toBe('companies')
    expect(toPlural('Book')).toBe('books')
    expect(toPlural('STATUS')).toBe('status')
  })
})

// ── Integration: route path and nested-body key must agree ────────────────────
//
// Before the pluralization fix, routes.ts had its own toPlural and
// relations/index.ts used naive "+ 's'", causing category→categorys mismatch.
// This test exercises both sides through createRuntime to catch any future drift.

describe('toPlural — route path and nested extraction key agree', () => {
  it('Category → /categories (route) and categories (nested body key)', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0', name: 'plural-test',
      resources: [
        { name: 'Category', fields: { label: { type: 'string', required: true } } },
        {
          name: 'Article',
          fields: { headline: { type: 'string', required: true } },
          relations: [{ type: 'manyToMany', resource: 'Category', through: 'art_cats', fields: {} }],
        },
      ],
    }
    const { app } = createRuntime(spec, {
      enableLogging: false, enableDocs: false,
      enableHelmet: false, enableCors: false, enableSanitize: false,
    })

    // Route must be /categories (not /categorys)
    const catRes = await app.request('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Tech' }),
    })
    expect(catRes.status).toBe(201)
    const { data: cat } = await catRes.json() as { data: { id: string } }

    // Nested body key must be 'categories' (not 'categorys')
    const artRes = await app.request('/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headline: 'Test', categories: [{ categoryId: cat.id }] }),
    })
    expect(artRes.status).toBe(201)
    const { data: art } = await artRes.json() as { data: { id: string } }

    // Include must resolve the join — confirms both sides used the same pluralization
    const incRes = await app.request(`/articles/${art.id}?include=Category`)
    const { data } = await incRes.json() as { data: { category: Array<{ label: string }> } }
    expect(data.category).toHaveLength(1)
    expect(data.category[0]?.label).toBe('Tech')
  })

  it('Company → /companies (route) and companies (nested body key)', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0', name: 'company-plural-test',
      resources: [
        { name: 'Company', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Job',
          fields: { title: { type: 'string', required: true } },
          relations: [{ type: 'manyToMany', resource: 'Company', through: 'job_companies', fields: {} }],
        },
      ],
    }
    const { app } = createRuntime(spec, {
      enableLogging: false, enableDocs: false,
      enableHelmet: false, enableCors: false, enableSanitize: false,
    })

    // Route must be /companies
    const coRes = await app.request('/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    })
    expect(coRes.status).toBe(201)
    const { data: co } = await coRes.json() as { data: { id: string } }

    // Nested body key must be 'companies'
    const jobRes = await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Engineer', companies: [{ companyId: co.id }] }),
    })
    expect(jobRes.status).toBe(201)
    const { data: job } = await jobRes.json() as { data: { id: string } }

    const incRes = await app.request(`/jobs/${job.id}?include=Company`)
    const { data } = await incRes.json() as { data: { company: Array<{ name: string }> } }
    expect(data.company).toHaveLength(1)
    expect(data.company[0]?.name).toBe('Acme')
  })

  it('Status (ends in -s) → /status (route, unchanged)', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0', name: 'status-plural-test',
      resources: [{ name: 'Status', fields: { label: { type: 'string', required: true } } }],
    }
    const { app } = createRuntime(spec, {
      enableLogging: false, enableDocs: false,
      enableHelmet: false, enableCors: false, enableSanitize: false,
    })

    const res = await app.request('/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'active' }),
    })
    expect(res.status).toBe(201)

    const list = await app.request('/status')
    const { count } = await list.json() as { count: number }
    expect(count).toBe(1)
  })
})
