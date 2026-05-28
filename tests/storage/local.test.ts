import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { existsSync } from 'fs'
import { rm, readFile } from 'fs/promises'
import { join } from 'path'
import { LocalStorage, mountLocalUploadRoute } from '../../src/storage/local.js'

const DIR = '/tmp/zeroapi-storage-local-test'

afterEach(async () => {
  if (existsSync(DIR)) await rm(DIR, { recursive: true, force: true })
})

describe('LocalStorage.upload', () => {
  it('writes the buffer to disk and returns a key + url', async () => {
    const storage = new LocalStorage({ uploadDir: DIR, baseUrl: 'http://example.test' })
    const result = await storage.upload({
      buffer: Buffer.from([1, 2, 3, 4]),
      filename: 'pic.png',
      mimeType: 'image/png',
    })
    expect(result.key).toMatch(/\.png$/)
    expect(result.url).toBe(`http://example.test/uploads/${result.key}`)
    const written = await readFile(join(DIR, result.key))
    expect(written).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('defaults the baseUrl to localhost when no env is set', () => {
    delete process.env['OAUTH_CALLBACK_BASE_URL']
    const storage = new LocalStorage({ uploadDir: DIR })
    expect(storage.getUrl('abc.png')).toBe('http://localhost:3000/uploads/abc.png')
  })

  it('prefers OAUTH_CALLBACK_BASE_URL when set', () => {
    const prev = process.env['OAUTH_CALLBACK_BASE_URL']
    process.env['OAUTH_CALLBACK_BASE_URL'] = 'https://api.zeroapi.cloud/'
    try {
      const storage = new LocalStorage({ uploadDir: DIR })
      expect(storage.getUrl('abc.png')).toBe('https://api.zeroapi.cloud/uploads/abc.png')
    } finally {
      if (prev === undefined) delete process.env['OAUTH_CALLBACK_BASE_URL']
      else process.env['OAUTH_CALLBACK_BASE_URL'] = prev
    }
  })

  it('infers an extension from the mime type when filename has none', async () => {
    const storage = new LocalStorage({ uploadDir: DIR })
    const result = await storage.upload({
      buffer: Buffer.from('hello'),
      filename: 'no-extension',
      mimeType: 'image/jpeg',
    })
    expect(result.key).toMatch(/\.jpg$/)
  })
})

describe('LocalStorage.delete', () => {
  it('removes the file from disk', async () => {
    const storage = new LocalStorage({ uploadDir: DIR })
    const { key } = await storage.upload({
      buffer: Buffer.from([1]),
      filename: 'tmp.bin',
      mimeType: 'application/octet-stream',
    })
    expect(existsSync(join(DIR, key))).toBe(true)
    await storage.delete(key)
    expect(existsSync(join(DIR, key))).toBe(false)
  })

  it('does not throw when the file is missing', async () => {
    const storage = new LocalStorage({ uploadDir: DIR })
    await expect(storage.delete('never-existed.png')).resolves.toBeUndefined()
  })

  it('rejects keys that try to traverse out of the upload dir', async () => {
    const storage = new LocalStorage({ uploadDir: DIR })
    await expect(storage.delete('../etc/passwd')).rejects.toThrow(/Invalid storage key/)
  })
})

describe('GET /uploads/:key', () => {
  it('serves the uploaded file with the right MIME type', async () => {
    const storage = new LocalStorage({ uploadDir: DIR })
    const { key } = await storage.upload({
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
    })
    const app = new Hono()
    mountLocalUploadRoute(app, storage)
    const res = await app.request(`/uploads/${key}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/jpeg')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(body)).toEqual([0xff, 0xd8, 0xff])
  })

  it('returns 404 for unknown keys', async () => {
    const storage = new LocalStorage({ uploadDir: DIR })
    const app = new Hono()
    mountLocalUploadRoute(app, storage)
    const res = await app.request('/uploads/missing.png')
    expect(res.status).toBe(404)
  })

  it('returns 400 for traversal keys', async () => {
    const storage = new LocalStorage({ uploadDir: DIR })
    const app = new Hono()
    mountLocalUploadRoute(app, storage)
    const res = await app.request('/uploads/..')
    expect([400, 404]).toContain(res.status) // Hono router may not match `..` at all
  })
})
