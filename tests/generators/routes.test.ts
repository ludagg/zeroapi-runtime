import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../src/index.js'
import { sampleSpec } from '../fixtures/sample-spec.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const { app } = createRuntime(sampleSpec, { enableLogging: false })

describe('Generated routes — User resource', () => {
  let createdId: string

  it('GET /users — returns empty list initially', async () => {
    const res = await app.request('/users')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[]; count: number }
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.count).toBe(0)
  })

  it('POST /users — creates a user with valid body', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { id: string; name: string; email: string } }
    expect(typeof body.data.id).toBe('string')
    expect(body.data.name).toBe('Alice')
    expect(body.data.email).toBe('alice@example.com')
    createdId = body.data.id
  })

  it('POST /users — 422 when required field is missing', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NoEmail' }),
    })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string; details: unknown[] }
    expect(body.error).toBe('Validation failed')
    expect(Array.isArray(body.details)).toBe(true)
  })

  it('POST /users — 400 for malformed JSON', async () => {
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    })
    expect(res.status).toBe(400)
  })

  it('GET /users — list now includes created user', async () => {
    const res = await app.request('/users')
    const body = await res.json() as { data: unknown[]; count: number }
    expect(body.count).toBe(1)
  })

  it('GET /users/:id — reads created user', async () => {
    const res = await app.request(`/users/${createdId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: string } }
    expect(body.data.id).toBe(createdId)
  })

  it('GET /users/:id — 404 for unknown id', async () => {
    const res = await app.request('/users/non-existent-id')
    expect(res.status).toBe(404)
  })

  it('PUT /users/:id — updates existing user', async () => {
    const res = await app.request(`/users/${createdId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice Updated' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { name: string } }
    expect(body.data.name).toBe('Alice Updated')
  })

  it('PUT /users/:id — 404 for unknown id', async () => {
    const res = await app.request('/users/bad-id', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /users/:id — deletes user', async () => {
    const res = await app.request(`/users/${createdId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('DELETE /users/:id — 404 after deletion', async () => {
    const res = await app.request(`/users/${createdId}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('Generated routes — /health endpoint', () => {
  it('returns status ok with spec metadata', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; name: string; version: string }
    expect(body.status).toBe('ok')
    expect(body.name).toBe('test-api')
    expect(body.version).toBe('1.0.0')
  })
})

describe('Generated routes — id integrity', () => {
  it('client-supplied id in body must not desync item.id from the store key', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'contacts-api',
      resources: [
        {
          name: 'Contact',
          fields: {
            id: { type: 'uuid', required: false },
            nom: { type: 'string', required: true },
          },
        },
      ],
    }
    const { app: contactsApp } = createRuntime(spec, { enableLogging: false })

    const clientId = '256399b1-639a-4f49-9e54-efb8fa08ffa5'
    const createRes = await contactsApp.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientId, nom: 'ludo' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { data: { id: string; nom: string } }

    const listRes = await contactsApp.request('/contacts')
    const list = await listRes.json() as { data: Array<{ id: string }> }
    expect(list.data).toHaveLength(1)
    const listedId = list.data[0]!.id

    const readRes = await contactsApp.request(`/contacts/${listedId}`)
    expect(readRes.status).toBe(200)
    const read = await readRes.json() as { data: { id: string; nom: string } }
    expect(read.data.id).toBe(listedId)
    expect(read.data.nom).toBe('ludo')
    expect(created.data.id).toBe(listedId)
  })

  it('client-supplied id in PUT body must not desync item.id from the store key', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'contacts-api',
      resources: [
        {
          name: 'Contact',
          fields: {
            id: { type: 'uuid', required: false },
            nom: { type: 'string', required: true },
          },
        },
      ],
    }
    const { app: contactsApp } = createRuntime(spec, { enableLogging: false })

    const createRes = await contactsApp.request('/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nom: 'ludo' }),
    })
    const created = await createRes.json() as { data: { id: string } }
    const realId = created.data.id

    const putRes = await contactsApp.request(`/contacts/${realId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'cafef00d-0000-0000-0000-000000000000', nom: 'updated' }),
    })
    expect(putRes.status).toBe(200)

    const readRes = await contactsApp.request(`/contacts/${realId}`)
    expect(readRes.status).toBe(200)
    const read = await readRes.json() as { data: { id: string; nom: string } }
    expect(read.data.id).toBe(realId)
    expect(read.data.nom).toBe('updated')
  })
})

describe('Generated routes — endpoint restriction', () => {
  it('only exposes configured endpoints when endpoints array is provided', async () => {
    const restrictedSpec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'restricted',
      resources: [
        {
          name: 'Widget',
          fields: { label: { type: 'string', required: true } },
          endpoints: ['list', 'create'],
        },
      ],
    }
    const { app: restrictedApp } = createRuntime(restrictedSpec, { enableLogging: false })

    const listRes = await restrictedApp.request('/widgets')
    expect(listRes.status).toBe(200)

    const createRes = await restrictedApp.request('/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Test' }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { data: { id: string } }

    // read is not in endpoints — should 404
    const readRes = await restrictedApp.request(`/widgets/${created.data.id}`)
    expect(readRes.status).toBe(404)
  })
})
