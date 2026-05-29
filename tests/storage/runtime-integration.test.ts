import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { createRuntime } from '../../src/index.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const DIR = '/tmp/zeroapi-runtime-integration-test'

afterEach(async () => {
  if (existsSync(DIR)) await rm(DIR, { recursive: true, force: true })
})

const baseSpec: ZeroAPISpec = {
  version: '1.0', name: 'test-api',
  resources: [{
    name: 'Doc',
    fields: { title: { type: 'string', required: true } },
  }],
}

describe('runtime — fileUpload disabled', () => {
  it('does not mount /upload routes when features.fileUpload is absent', async () => {
    const { app } = createRuntime(baseSpec, { enableLogging: false })
    const res = await app.request('/upload', {
      method: 'POST', body: new FormData(),
    })
    expect(res.status).toBe(404)
  })

  it('does not mount /uploads/:key when feature is absent', async () => {
    const { app } = createRuntime(baseSpec, { enableLogging: false })
    const res = await app.request('/uploads/whatever')
    expect(res.status).toBe(404)
  })

  it('runtime stays backwards-compatible (no spec change)', () => {
    expect(() => createRuntime(baseSpec, { enableLogging: false })).not.toThrow()
  })
})

describe('runtime — fileUpload enabled (local)', () => {
  const spec: ZeroAPISpec = {
    ...baseSpec,
    features: {
      fileUpload: {
        enabled: true, provider: 'local',
        maxSizeMB: 1, allowedTypes: ['image/png', 'image/jpeg'],
      },
    },
  }

  it('mounts POST /upload + DELETE /upload/:key + GET /uploads/:key', async () => {
    const { app } = createRuntime(spec, {
      enableLogging: false, uploadDir: DIR,
      storageBootLogger: () => {},
    })

    const fd = new FormData()
    fd.append('file', new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' }))
    const up = await app.request('/upload', { method: 'POST', body: fd })
    expect(up.status).toBe(201)
    const { key } = await up.json() as { key: string; url: string }

    const get = await app.request(`/uploads/${key}`)
    expect(get.status).toBe(200)
    const buf = new Uint8Array(await get.arrayBuffer())
    expect(Array.from(buf)).toEqual([1, 2, 3])

    const del = await app.request(`/upload/${key}`, { method: 'DELETE' })
    expect(del.status).toBe(204)

    const gone = await app.request(`/uploads/${key}`)
    expect(gone.status).toBe(404)
  })

  it('rejects oversized files with 413', async () => {
    const tiny = { ...spec, features: { fileUpload: { ...spec.features!.fileUpload!, maxSizeMB: 0.0001 } } }
    const { app } = createRuntime(tiny, {
      enableLogging: false, uploadDir: DIR,
      storageBootLogger: () => {},
    })
    const fd = new FormData()
    fd.append('file', new File([new Uint8Array(2048)], 'p.png', { type: 'image/png' }))
    const res = await app.request('/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(413)
  })

  it('rejects bad MIME with 415', async () => {
    const { app } = createRuntime(spec, {
      enableLogging: false, uploadDir: DIR,
      storageBootLogger: () => {},
    })
    const fd = new FormData()
    fd.append('file', new File(['x'], 's.js', { type: 'application/javascript' }))
    const res = await app.request('/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(415)
  })
})

describe('runtime — file fields store the key/url', () => {
  it('POST on a resource with a file field persists the uploaded URL as a string', async () => {
    const spec: ZeroAPISpec = {
      version: '1.0', name: 'docs-api',
      resources: [{
        name: 'Doc',
        fields: {
          title: { type: 'string', required: true },
          attachment: {
            type: 'file', accept: ['application/pdf'],
            maxSize: '5MB', storage: 'local',
          },
        },
      }],
      features: {
        fileUpload: {
          enabled: true, provider: 'local',
          maxSizeMB: 5, allowedTypes: ['application/pdf'],
        },
      },
    }
    const { app } = createRuntime(spec, {
      enableLogging: false, uploadDir: DIR,
      storageBootLogger: () => {},
    })

    const fd = new FormData()
    fd.append('title', 'Manual')
    fd.append('attachment', new File([new Uint8Array([37, 80, 68, 70])], 'doc.pdf', { type: 'application/pdf' }))

    const res = await app.request('/docs', { method: 'POST', body: fd })
    expect(res.status).toBe(201)
    const env = await res.json() as { data: { id: string; title: string; attachment: string } }
    expect(env.data.title).toBe('Manual')
    expect(typeof env.data.attachment).toBe('string')
    expect(env.data.attachment).toMatch(/\/uploads\//)
  })
})

describe('runtime — local + production warning', () => {
  const spec: ZeroAPISpec = {
    ...baseSpec,
    features: {
      fileUpload: {
        enabled: true, provider: 'local',
        maxSizeMB: 1, allowedTypes: [],
      },
    },
  }

  it('logs the loud warning when NODE_ENV=production and provider=local', () => {
    const prev = process.env['NODE_ENV']
    process.env['NODE_ENV'] = 'production'
    const lines: string[] = []
    try {
      createRuntime(spec, {
        enableLogging: false, uploadDir: DIR,
        storageBootLogger: (l) => lines.push(l),
      })
    } finally {
      if (prev === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = prev
    }
    expect(lines.some((l) => l.includes('DANGER'))).toBe(true)
    expect(lines.some((l) => l.includes('S3/R2'))).toBe(true)
  })

  it('does not crash when local + production', () => {
    const prev = process.env['NODE_ENV']
    process.env['NODE_ENV'] = 'production'
    try {
      expect(() => createRuntime(spec, {
        enableLogging: false, uploadDir: DIR,
        storageBootLogger: () => {},
      })).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = prev
    }
  })
})
