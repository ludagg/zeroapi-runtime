import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import {
  LocalStorage, mountUploadRoutes,
} from '../../src/storage/index.js'
import type { FileUploadFeature } from '../../src/types/spec.js'
import type { StorageProvider } from '../../src/storage/index.js'

const DIR = '/tmp/zeroapi-storage-routes-test'

afterEach(async () => {
  if (existsSync(DIR)) await rm(DIR, { recursive: true, force: true })
})

function multipart(parts: Record<string, Blob | string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(parts)) {
    if (typeof v === 'string') fd.append(k, v)
    else fd.append(k, v, (v as File).name ?? 'file')
  }
  return fd
}

function makeApp(feature: FileUploadFeature, opts: { storage?: StorageProvider; auth?: boolean } = {}) {
  const storage = opts.storage ?? new LocalStorage({ uploadDir: DIR, baseUrl: 'http://test' })
  const app = new Hono()
  mountUploadRoutes(app, storage, feature, opts.auth
    ? {
        authMiddleware: async (c, next) => {
          if (c.req.header('authorization') !== 'Bearer ok') {
            return c.json({ error: 'Unauthorized' }, 401)
          }
          return next()
        },
      }
    : {})
  return { app, storage }
}

const PHOTO_FEATURE: FileUploadFeature = {
  enabled: true, provider: 'local',
  maxSizeMB: 1, allowedTypes: ['image/png', 'image/jpeg'],
}

describe('POST /upload', () => {
  it('uploads a valid file and returns 201 with key + url', async () => {
    const { app } = makeApp(PHOTO_FEATURE)
    const fd = multipart({ file: new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' }) })
    const res = await app.request('/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(201)
    const json = await res.json() as { key: string; url: string }
    expect(json.key).toMatch(/\.png$/)
    expect(json.url).toBe(`http://test/uploads/${json.key}`)
  })

  it('returns 415 for an unsupported MIME type', async () => {
    const { app } = makeApp(PHOTO_FEATURE)
    const fd = multipart({ file: new File(['x'], 'script.js', { type: 'application/javascript' }) })
    const res = await app.request('/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(415)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('Unsupported file type')
    expect(json.error).toContain('image/png')
  })

  it('returns 413 when file exceeds maxSizeMB', async () => {
    const { app } = makeApp({ ...PHOTO_FEATURE, maxSizeMB: 0.001 }) // ~1 KB
    const big = new Uint8Array(2048)
    const fd = multipart({ file: new File([big], 'big.png', { type: 'image/png' }) })
    const res = await app.request('/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(413)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('File too large')
  })

  it('returns 400 when no file is sent', async () => {
    const { app } = makeApp(PHOTO_FEATURE)
    const fd = multipart({ notFile: 'hello' })
    const res = await app.request('/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(400)
  })

  it('accepts any MIME when allowedTypes is empty', async () => {
    const { app } = makeApp({ ...PHOTO_FEATURE, allowedTypes: [] })
    const fd = multipart({ file: new File(['x'], 'data.bin', { type: 'application/octet-stream' }) })
    const res = await app.request('/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(201)
  })

  it('supports wildcard MIME patterns like image/*', async () => {
    const { app } = makeApp({ ...PHOTO_FEATURE, allowedTypes: ['image/*'] })
    const fd = multipart({ file: new File(['x'], 'pic.webp', { type: 'image/webp' }) })
    const res = await app.request('/upload', { method: 'POST', body: fd })
    expect(res.status).toBe(201)
  })

  it('is protected when an auth middleware is supplied', async () => {
    const { app } = makeApp(PHOTO_FEATURE, { auth: true })
    const fd = multipart({ file: new File(['x'], 'pic.png', { type: 'image/png' }) })
    const unauth = await app.request('/upload', { method: 'POST', body: fd })
    expect(unauth.status).toBe(401)
    const ok = await app.request('/upload', {
      method: 'POST', body: fd, headers: { authorization: 'Bearer ok' },
    })
    expect(ok.status).toBe(201)
  })
})

describe('DELETE /upload/:key', () => {
  it('removes a file uploaded via the local provider', async () => {
    const { app, storage } = makeApp(PHOTO_FEATURE)
    const fd = multipart({ file: new File(['xx'], 'pic.png', { type: 'image/png' }) })
    const created = await app.request('/upload', { method: 'POST', body: fd })
    const { key } = await created.json() as { key: string }
    expect(existsSync((storage as LocalStorage).pathFor(key))).toBe(true)

    const res = await app.request(`/upload/${key}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(existsSync((storage as LocalStorage).pathFor(key))).toBe(false)
  })

  it('is protected when auth is on', async () => {
    const { app } = makeApp(PHOTO_FEATURE, { auth: true })
    const res = await app.request('/upload/some-key', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })
})

describe('mountUploadRoutes with a mock S3-like provider', () => {
  it('calls the provider upload + delete', async () => {
    const calls: string[] = []
    const fake: StorageProvider = {
      upload: async (file) => {
        calls.push(`upload:${file.filename}:${file.mimeType}:${file.buffer.length}`)
        return { key: 'mock-key.png', url: 'https://cdn.test/mock-key.png' }
      },
      delete: async (key) => { calls.push(`delete:${key}`) },
      getUrl: (k) => `https://cdn.test/${k}`,
    }
    const { app } = makeApp(PHOTO_FEATURE, { storage: fake })

    const fd = multipart({ file: new File(['xyz'], 'pic.png', { type: 'image/png' }) })
    const up = await app.request('/upload', { method: 'POST', body: fd })
    expect(up.status).toBe(201)
    expect(await up.json()).toEqual({ key: 'mock-key.png', url: 'https://cdn.test/mock-key.png' })

    const del = await app.request('/upload/mock-key.png', { method: 'DELETE' })
    expect(del.status).toBe(204)

    expect(calls).toEqual([
      'upload:pic.png:image/png:3',
      'delete:mock-key.png',
    ])
  })
})

// Reference `beforeEach` so the import isn't flagged as unused in stricter test setups.
beforeEach(() => {})
