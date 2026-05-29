import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  resolveStorageProvider, LOCAL_IN_PROD_WARNING,
  LocalStorage, S3Storage,
  __setS3ModuleForTests, __resetS3ModuleCache,
  S3_ENDPOINT_ENV, S3_BUCKET_ENV, S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV, S3_REGION_ENV, S3_PUBLIC_URL_ENV,
} from '../../src/storage/index.js'
import type { FileUploadFeature } from '../../src/types/spec.js'

const S3_ENVS = [
  S3_ENDPOINT_ENV, S3_BUCKET_ENV, S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV, S3_REGION_ENV, S3_PUBLIC_URL_ENV,
] as const
function clearS3Env() { for (const k of S3_ENVS) delete process.env[k] }

function fakeS3Module() {
  class S3Client { async send(): Promise<unknown> { return {} } }
  class PutObjectCommand {}
  class DeleteObjectCommand {}
  return { S3Client, PutObjectCommand, DeleteObjectCommand }
}

describe('resolveStorageProvider', () => {
  beforeEach(() => clearS3Env())
  afterEach(() => { __resetS3ModuleCache(); clearS3Env() })

  function feature(provider: 's3' | 'r2' | 'local'): FileUploadFeature {
    return { enabled: true, provider, maxSizeMB: 5, allowedTypes: [] }
  }

  it('returns LocalStorage for provider=local in dev', () => {
    const provider = resolveStorageProvider(feature('local'), { nodeEnv: 'development' })
    expect(provider).toBeInstanceOf(LocalStorage)
  })

  it('logs the production warning when provider=local in NODE_ENV=production', () => {
    const lines: string[] = []
    const provider = resolveStorageProvider(feature('local'), {
      nodeEnv: 'production',
      log: (l) => lines.push(l),
    })
    expect(provider).toBeInstanceOf(LocalStorage)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(LOCAL_IN_PROD_WARNING)
    expect(lines[0]).toContain('DANGER')
    expect(lines[0]).toContain('S3/R2')
  })

  it('does not warn for local in development', () => {
    const lines: string[] = []
    resolveStorageProvider(feature('local'), { nodeEnv: 'development', log: (l) => lines.push(l) })
    expect(lines).toEqual([])
  })

  it('builds an S3Storage when provider=s3 and env is set', () => {
    process.env[S3_BUCKET_ENV] = 'b'
    process.env[S3_ACCESS_KEY_ID_ENV] = 'A'
    process.env[S3_SECRET_ACCESS_KEY_ENV] = 'S'
    __setS3ModuleForTests(fakeS3Module() as never)
    const provider = resolveStorageProvider(feature('s3'))
    expect(provider).toBeInstanceOf(S3Storage)
  })

  it('builds an S3Storage when provider=r2', () => {
    process.env[S3_BUCKET_ENV] = 'b'
    process.env[S3_ACCESS_KEY_ID_ENV] = 'A'
    process.env[S3_SECRET_ACCESS_KEY_ENV] = 'S'
    process.env[S3_ENDPOINT_ENV] = 'https://abc.r2.cloudflarestorage.com'
    __setS3ModuleForTests(fakeS3Module() as never)
    const provider = resolveStorageProvider(feature('r2'))
    expect(provider).toBeInstanceOf(S3Storage)
  })

  it('auto-detects S3 when provider=local but S3 env vars are present', () => {
    process.env[S3_BUCKET_ENV] = 'b'
    process.env[S3_ACCESS_KEY_ID_ENV] = 'A'
    process.env[S3_SECRET_ACCESS_KEY_ENV] = 'S'
    __setS3ModuleForTests(fakeS3Module() as never)
    const provider = resolveStorageProvider(feature('local'))
    expect(provider).toBeInstanceOf(S3Storage)
  })

  it('throws when provider=s3 but env vars are missing', () => {
    expect(() => resolveStorageProvider(feature('s3'))).toThrow(/S3 storage is enabled/)
  })

  it('throws when provider=s3 but the SDK is missing', () => {
    process.env[S3_BUCKET_ENV] = 'b'
    process.env[S3_ACCESS_KEY_ID_ENV] = 'A'
    process.env[S3_SECRET_ACCESS_KEY_ENV] = 'S'
    __resetS3ModuleCache()
    expect(() => resolveStorageProvider(feature('s3'))).toThrow(/@aws-sdk\/client-s3/)
  })
})
