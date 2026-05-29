import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  S3Storage, loadS3Module, hasS3EnvConfig, readS3ConfigFromEnv,
  __setS3ModuleForTests, __resetS3ModuleCache,
  S3_ENDPOINT_ENV, S3_BUCKET_ENV, S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV, S3_REGION_ENV, S3_PUBLIC_URL_ENV,
} from '../../src/storage/s3.js'

interface PutInput { Bucket: string; Key: string; Body: Buffer; ContentType: string }
interface DeleteInput { Bucket: string; Key: string }

function makeMockS3() {
  const sent: unknown[] = []
  const clientConfigs: Record<string, unknown>[] = []
  const putInputs: PutInput[] = []
  const deleteInputs: DeleteInput[] = []

  class S3Client {
    constructor(cfg: Record<string, unknown>) { clientConfigs.push(cfg) }
    async send(cmd: unknown): Promise<{ ok: true }> { sent.push(cmd); return { ok: true } }
  }
  class PutObjectCommand {
    readonly tag = 'PutObject'
    constructor(public input: PutInput) { putInputs.push(input) }
  }
  class DeleteObjectCommand {
    readonly tag = 'DeleteObject'
    constructor(public input: DeleteInput) { deleteInputs.push(input) }
  }

  return {
    module: {
      S3Client: S3Client as unknown as new (c: Record<string, unknown>) => unknown,
      PutObjectCommand: PutObjectCommand as unknown as new (i: Record<string, unknown>) => unknown,
      DeleteObjectCommand: DeleteObjectCommand as unknown as new (i: Record<string, unknown>) => unknown,
    },
    sent, clientConfigs, putInputs, deleteInputs,
  }
}

const S3_ENVS = [
  S3_ENDPOINT_ENV, S3_BUCKET_ENV, S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV, S3_REGION_ENV, S3_PUBLIC_URL_ENV,
] as const

function clearS3Env() {
  for (const k of S3_ENVS) delete process.env[k]
}

describe('S3Storage with mocked SDK', () => {
  beforeEach(() => clearS3Env())
  afterEach(() => { __resetS3ModuleCache(); clearS3Env() })

  it('calls PutObjectCommand with the right inputs on upload', async () => {
    const mock = makeMockS3()
    __setS3ModuleForTests(mock.module as never)

    const storage = new S3Storage({
      bucket: 'my-bucket', region: 'us-east-1',
      accessKeyId: 'AKIA', secretAccessKey: 'SECRET',
    })

    const result = await storage.upload({
      buffer: Buffer.from('hello'),
      filename: 'avatar.png',
      mimeType: 'image/png',
    })

    expect(mock.putInputs).toHaveLength(1)
    expect(mock.putInputs[0]?.Bucket).toBe('my-bucket')
    expect(mock.putInputs[0]?.ContentType).toBe('image/png')
    expect(mock.putInputs[0]?.Body).toEqual(Buffer.from('hello'))
    expect(mock.putInputs[0]?.Key).toMatch(/\.png$/)
    expect(result.key).toBe(mock.putInputs[0]?.Key)
    expect(result.url).toBe(`https://my-bucket.s3.us-east-1.amazonaws.com/${result.key}`)
  })

  it('calls DeleteObjectCommand on delete', async () => {
    const mock = makeMockS3()
    __setS3ModuleForTests(mock.module as never)
    const storage = new S3Storage({
      bucket: 'b', accessKeyId: 'A', secretAccessKey: 'S',
    })
    await storage.delete('some/key.png')
    expect(mock.deleteInputs).toEqual([{ Bucket: 'b', Key: 'some/key.png' }])
  })

  it('forwards a custom endpoint + forcePathStyle (R2 / MinIO)', async () => {
    const mock = makeMockS3()
    __setS3ModuleForTests(mock.module as never)
    new S3Storage({
      bucket: 'r2-bucket',
      accessKeyId: 'A', secretAccessKey: 'S',
      endpoint: 'https://abc.r2.cloudflarestorage.com',
    })
    expect(mock.clientConfigs[0]?.['endpoint']).toBe('https://abc.r2.cloudflarestorage.com')
    expect(mock.clientConfigs[0]?.['forcePathStyle']).toBe(true)
  })

  it('uses publicUrl when provided', async () => {
    const mock = makeMockS3()
    __setS3ModuleForTests(mock.module as never)
    const storage = new S3Storage({
      bucket: 'b', accessKeyId: 'A', secretAccessKey: 'S',
      publicUrl: 'https://cdn.example.com/',
    })
    expect(storage.getUrl('foo.png')).toBe('https://cdn.example.com/foo.png')
  })

  it('falls back to {endpoint}/{bucket}/{key} when no publicUrl is set', async () => {
    const mock = makeMockS3()
    __setS3ModuleForTests(mock.module as never)
    const storage = new S3Storage({
      bucket: 'b', accessKeyId: 'A', secretAccessKey: 'S',
      endpoint: 'https://abc.r2.cloudflarestorage.com',
    })
    expect(storage.getUrl('foo.png')).toBe('https://abc.r2.cloudflarestorage.com/b/foo.png')
  })
})

describe('loadS3Module', () => {
  beforeEach(() => __resetS3ModuleCache())
  afterEach(() => __resetS3ModuleCache())

  it('throws a clear error when @aws-sdk/client-s3 is not installed', () => {
    expect(() => loadS3Module()).toThrow(/@aws-sdk\/client-s3/)
  })
})

describe('readS3ConfigFromEnv', () => {
  beforeEach(() => clearS3Env())
  afterEach(() => clearS3Env())

  it('reads required env vars', () => {
    process.env[S3_BUCKET_ENV] = 'b'
    process.env[S3_ACCESS_KEY_ID_ENV] = 'A'
    process.env[S3_SECRET_ACCESS_KEY_ENV] = 'S'
    const cfg = readS3ConfigFromEnv()
    expect(cfg).toEqual({ bucket: 'b', accessKeyId: 'A', secretAccessKey: 'S' })
  })

  it('includes optional env vars when set', () => {
    process.env[S3_BUCKET_ENV] = 'b'
    process.env[S3_ACCESS_KEY_ID_ENV] = 'A'
    process.env[S3_SECRET_ACCESS_KEY_ENV] = 'S'
    process.env[S3_ENDPOINT_ENV] = 'https://r2.example'
    process.env[S3_REGION_ENV] = 'auto'
    process.env[S3_PUBLIC_URL_ENV] = 'https://cdn.example'
    const cfg = readS3ConfigFromEnv()
    expect(cfg.endpoint).toBe('https://r2.example')
    expect(cfg.region).toBe('auto')
    expect(cfg.publicUrl).toBe('https://cdn.example')
  })

  it('throws when required env vars are missing', () => {
    expect(() => readS3ConfigFromEnv()).toThrow(/required env vars are missing/)
  })
})

describe('hasS3EnvConfig', () => {
  beforeEach(() => clearS3Env())
  afterEach(() => clearS3Env())

  it('returns false when any var is missing', () => {
    expect(hasS3EnvConfig()).toBe(false)
    process.env[S3_BUCKET_ENV] = 'b'
    expect(hasS3EnvConfig()).toBe(false)
  })

  it('returns true when the three core vars are set', () => {
    process.env[S3_BUCKET_ENV] = 'b'
    process.env[S3_ACCESS_KEY_ID_ENV] = 'A'
    process.env[S3_SECRET_ACCESS_KEY_ENV] = 'S'
    expect(hasS3EnvConfig()).toBe(true)
  })
})

// Vitest's auto-mock is unused here — we inject via __setS3ModuleForTests.
// Keep a reference so it isn't dropped by tree-shaking in test output.
vi.fn()
