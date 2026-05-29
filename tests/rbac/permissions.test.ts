import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

function makeRbacToken(role: string): string {
  const header  = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: '1', role })).toString('base64url')
  return `${header}.${payload}.`
}

const rbacSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'rbac-test-api',
  auth: { strategy: 'bearer' },
  roles: [
    { name: 'admin', inherits: ['editor'] },
    { name: 'editor', inherits: ['viewer'] },
    { name: 'viewer' },
  ],
  resources: [
    {
      name: 'Article',
      fields: {
        title: { type: 'string', required: true },
      },
      rbac: {
        read:   ['viewer'],
        write:  ['editor'],
        delete: ['admin'],
      },
    },
  ],
}

const { app } = createRuntime(rbacSpec, { enableLogging: false, enableDocs: false })

describe('RBAC — permission middleware', () => {
  it('GET /articles — 403 without token', async () => {
    const res = await app.request('/articles')
    expect(res.status).toBe(401)
  })

  it('GET /articles — 200 for viewer role', async () => {
    const res = await app.request('/articles', {
      headers: { Authorization: `Bearer ${makeRbacToken('viewer')}` },
    })
    expect(res.status).toBe(200)
  })

  it('GET /articles — 200 for admin (inherits viewer)', async () => {
    const res = await app.request('/articles', {
      headers: { Authorization: `Bearer ${makeRbacToken('admin')}` },
    })
    expect(res.status).toBe(200)
  })

  it('POST /articles — 403 for viewer (no write permission)', async () => {
    const res = await app.request('/articles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${makeRbacToken('viewer')}`,
      },
      body: JSON.stringify({ title: 'Test Article' }),
    })
    expect(res.status).toBe(403)
  })

  it('POST /articles — 201 for editor role', async () => {
    const res = await app.request('/articles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${makeRbacToken('editor')}`,
      },
      body: JSON.stringify({ title: 'Test Article' }),
    })
    expect(res.status).toBe(201)
  })

  it('POST /articles — 201 for admin (inherits editor)', async () => {
    const res = await app.request('/articles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${makeRbacToken('admin')}`,
      },
      body: JSON.stringify({ title: 'Admin Article' }),
    })
    expect(res.status).toBe(201)
  })

  it('DELETE /articles/:id — 403 for editor (no delete permission)', async () => {
    // First create an article as admin
    const createRes = await app.request('/articles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${makeRbacToken('admin')}`,
      },
      body: JSON.stringify({ title: 'To Delete' }),
    })
    const { data } = await createRes.json() as { data: { id: string } }

    const delRes = await app.request(`/articles/${data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${makeRbacToken('editor')}` },
    })
    expect(delRes.status).toBe(403)
  })

  it('DELETE /articles/:id — 200 for admin role', async () => {
    const createRes = await app.request('/articles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${makeRbacToken('admin')}`,
      },
      body: JSON.stringify({ title: 'Admin Delete' }),
    })
    const { data } = await createRes.json() as { data: { id: string } }

    const delRes = await app.request(`/articles/${data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${makeRbacToken('admin')}` },
    })
    expect(delRes.status).toBe(200)
  })
})
