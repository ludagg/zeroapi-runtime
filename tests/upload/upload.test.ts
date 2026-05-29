import { describe, it, expect, afterEach } from 'vitest'
import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { parseSpec } from '../../src/parser/index.js'
import { validateFile, parseMaxSize, processFileFields } from '../../src/upload/index.js'
import { uploadLocal } from '../../src/upload/providers/local.js'
import { generatePresignedPutUrl } from '../../src/upload/providers/s3.js'
import type { FieldDefinition } from '../../src/types/spec.js'

const TEST_UPLOAD_DIR = '/tmp/zeroapi-test-uploads'

afterEach(async () => {
  if (existsSync(TEST_UPLOAD_DIR)) {
    await rm(TEST_UPLOAD_DIR, { recursive: true, force: true })
  }
})

// ── Parser ────────────────────────────────────────────────────────────────────

describe('Parser — file field type', () => {
  it('accepts file field type in spec', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'api',
        resources: [{
          name: 'Doc',
          fields: {
            title: { type: 'string', required: true },
            attachment: { type: 'file', accept: ['application/pdf'], maxSize: '5MB', storage: 'local' },
          },
        }],
      })
    ).not.toThrow()
  })
})

// ── Size parsing ──────────────────────────────────────────────────────────────

describe('parseMaxSize', () => {
  it('parses MB', () => { expect(parseMaxSize('5MB')).toBe(5 * 1024 * 1024) })
  it('parses KB', () => { expect(parseMaxSize('512KB')).toBe(512 * 1024) })
  it('parses GB', () => { expect(parseMaxSize('1GB')).toBe(1024 ** 3) })
  it('returns 10MB default for invalid', () => { expect(parseMaxSize('invalid')).toBe(10 * 1024 * 1024) })
})

// ── File validation ───────────────────────────────────────────────────────────

function makeFile(name: string, type: string, size: number): File {
  const buf = new Uint8Array(size)
  return new File([buf], name, { type })
}

describe('validateFile', () => {
  it('passes when no restrictions', () => {
    const field: FieldDefinition = { type: 'file' }
    const file = makeFile('test.png', 'image/png', 100)
    expect(validateFile(file, field)).toBeNull()
  })

  it('fails for disallowed MIME type', () => {
    const field: FieldDefinition = { type: 'file', accept: ['image/jpeg'] }
    const file = makeFile('test.png', 'image/png', 100)
    const err = validateFile(file, field)
    expect(err).not.toBeNull()
    expect(err?.message).toContain('not allowed')
  })

  it('passes for allowed MIME type', () => {
    const field: FieldDefinition = { type: 'file', accept: ['image/png', 'image/jpeg'] }
    const file = makeFile('test.png', 'image/png', 100)
    expect(validateFile(file, field)).toBeNull()
  })

  it('fails when file exceeds maxSize', () => {
    const field: FieldDefinition = { type: 'file', maxSize: '1KB' }
    const file = makeFile('big.png', 'image/png', 2048)
    const err = validateFile(file, field)
    expect(err).not.toBeNull()
    expect(err?.message).toContain('exceeds maximum')
  })
})

// ── Local upload ──────────────────────────────────────────────────────────────

describe('uploadLocal', () => {
  it('saves file and returns /uploads URL', async () => {
    const content = new Uint8Array([1, 2, 3, 4])
    const file = new File([content], 'test.bin', { type: 'application/octet-stream' })
    const result = await uploadLocal(file, TEST_UPLOAD_DIR)

    expect(result.url).toMatch(/^\/uploads\//)
    expect(result.size).toBe(4)
    expect(result.mimeType).toBe('application/octet-stream')
    expect(existsSync(`${TEST_UPLOAD_DIR}/${result.filename}`)).toBe(true)
  })
})

// ── S3 presigned URL ──────────────────────────────────────────────────────────

describe('generatePresignedPutUrl', () => {
  const config = {
    bucket: 'my-bucket',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }

  it('returns an uploadUrl containing X-Amz-Signature', () => {
    const result = generatePresignedPutUrl('uploads/test.jpg', config)
    expect(result.uploadUrl).toContain('X-Amz-Signature')
  })

  it('returns a fileUrl pointing to S3', () => {
    const result = generatePresignedPutUrl('uploads/test.jpg', config)
    expect(result.fileUrl).toContain('my-bucket')
    expect(result.fileUrl).toContain('test.jpg')
  })

  it('returns an expiresAt timestamp in the future', () => {
    const result = generatePresignedPutUrl('uploads/test.jpg', config)
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('uses custom R2 endpoint when provided', () => {
    const r2Config = { ...config, endpoint: 'https://abc123.r2.cloudflarestorage.com' }
    const result = generatePresignedPutUrl('uploads/doc.pdf', r2Config)
    expect(result.uploadUrl).toContain('r2.cloudflarestorage.com')
  })
})

// ── processFileFields ─────────────────────────────────────────────────────────

describe('processFileFields', () => {
  it('replaces File object with URL', async () => {
    const file = makeFile('photo.jpg', 'image/jpeg', 50)
    const fieldDefs: Record<string, FieldDefinition> = {
      image: { type: 'file', accept: ['image/jpeg'], storage: 'local' },
    }
    const { body, errors } = await processFileFields({ image: file }, fieldDefs, TEST_UPLOAD_DIR)
    expect(errors).toHaveLength(0)
    expect(typeof body['image']).toBe('string')
    expect(body['image'] as string).toMatch(/^\/uploads\//)
  })

  it('reports validation error for disallowed MIME', async () => {
    const file = makeFile('script.js', 'application/javascript', 100)
    const fieldDefs: Record<string, FieldDefinition> = {
      image: { type: 'file', accept: ['image/jpeg'] },
    }
    const { errors } = await processFileFields({ image: file }, fieldDefs, TEST_UPLOAD_DIR)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('not allowed')
  })

  it('passes non-file text fields through unchanged', async () => {
    const { body } = await processFileFields({ name: 'Alice' }, {}, TEST_UPLOAD_DIR)
    expect(body['name']).toBe('Alice')
  })
})
