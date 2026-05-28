import { extname } from 'path'
import { randomUUID } from 'crypto'
import { createRequire as createNodeRequire } from 'node:module'
import type { StorageProvider, UploadInput, UploadOutput } from './provider.js'

declare const require: NodeRequire | undefined

export const S3_ENDPOINT_ENV         = 'S3_ENDPOINT'
export const S3_BUCKET_ENV           = 'S3_BUCKET'
export const S3_ACCESS_KEY_ID_ENV    = 'S3_ACCESS_KEY_ID'
export const S3_SECRET_ACCESS_KEY_ENV = 'S3_SECRET_ACCESS_KEY'
export const S3_REGION_ENV           = 'S3_REGION'
export const S3_PUBLIC_URL_ENV       = 'S3_PUBLIC_URL'

export interface S3StorageConfig {
  bucket: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
  /** Custom endpoint for R2 / MinIO / any S3-compatible store. */
  endpoint?: string
  /**
   * Base URL prefix used to build public URLs returned by `getUrl()`.
   * For R2 this is typically the R2 public domain. When omitted the URL falls
   * back to the standard AWS S3 virtual-host style.
   */
  publicUrl?: string
}

interface S3ClientLike {
  send(command: unknown): Promise<unknown>
}

export interface S3Module {
  S3Client: new (config: Record<string, unknown>) => S3ClientLike
  PutObjectCommand: new (input: Record<string, unknown>) => unknown
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown
}

const SDK_PACKAGE = '@aws-sdk/client-s3'
const MISSING_SDK_HINT =
  `ZeroAPI: storage provider "s3"/"r2" requires the optional dependency "${SDK_PACKAGE}". ` +
  `Install it with: npm install ${SDK_PACKAGE}`

let cachedModule: S3Module | null = null

function resolveRequire(): NodeRequire | null {
  try {
    if (typeof require === 'function') return require
  } catch { /* not in scope under strict ESM */ }
  try {
    return createNodeRequire(import.meta.url)
  } catch {
    return null
  }
}

/** Loads `@aws-sdk/client-s3` on demand. Throws a clear error if missing. */
export function loadS3Module(): S3Module {
  if (cachedModule) return cachedModule
  const req = resolveRequire()
  if (!req) throw new Error(MISSING_SDK_HINT)
  try {
    cachedModule = req(SDK_PACKAGE) as S3Module
    return cachedModule
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(MISSING_SDK_HINT)
    }
    throw err
  }
}

/** Reset the cached module — test helper. */
export function __resetS3ModuleCache(): void {
  cachedModule = null
}

/** Inject a mock S3 module — test helper. */
export function __setS3ModuleForTests(mod: S3Module | null): void {
  cachedModule = mod
}

/**
 * Reads the runtime S3 configuration from environment variables.
 * Throws when a required setting is missing.
 */
export function readS3ConfigFromEnv(): S3StorageConfig {
  const bucket          = process.env[S3_BUCKET_ENV]
  const accessKeyId     = process.env[S3_ACCESS_KEY_ID_ENV]
  const secretAccessKey = process.env[S3_SECRET_ACCESS_KEY_ENV]

  const missing: string[] = []
  if (!bucket)          missing.push(S3_BUCKET_ENV)
  if (!accessKeyId)     missing.push(S3_ACCESS_KEY_ID_ENV)
  if (!secretAccessKey) missing.push(S3_SECRET_ACCESS_KEY_ENV)

  if (missing.length > 0) {
    throw new Error(
      `ZeroAPI: S3 storage is enabled but required env vars are missing: ${missing.join(', ')}`,
    )
  }

  const config: S3StorageConfig = {
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
  }
  const endpoint  = process.env[S3_ENDPOINT_ENV]
  const region    = process.env[S3_REGION_ENV]
  const publicUrl = process.env[S3_PUBLIC_URL_ENV]
  if (endpoint)  config.endpoint = endpoint
  if (region)    config.region = region
  if (publicUrl) config.publicUrl = publicUrl
  return config
}

/** Returns true when the minimum env vars for S3Storage are present. */
export function hasS3EnvConfig(): boolean {
  return !!(
    process.env[S3_BUCKET_ENV] &&
    process.env[S3_ACCESS_KEY_ID_ENV] &&
    process.env[S3_SECRET_ACCESS_KEY_ENV]
  )
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

function generateKey(filename: string): string {
  const ext = extname(filename)
  return `${randomUUID()}${ext}`
}

/**
 * S3-compatible `StorageProvider`. Works with AWS S3 (no endpoint) and
 * Cloudflare R2 / MinIO / any other S3-compatible store (custom endpoint).
 *
 * The `@aws-sdk/client-s3` package is loaded lazily via `require()` only when
 * an instance is constructed, so projects that don't use file upload don't pay
 * for the dependency.
 */
export class S3Storage implements StorageProvider {
  private readonly client: S3ClientLike
  private readonly PutObjectCommand: S3Module['PutObjectCommand']
  private readonly DeleteObjectCommand: S3Module['DeleteObjectCommand']
  readonly config: Required<Pick<S3StorageConfig, 'bucket' | 'accessKeyId' | 'secretAccessKey'>> &
    Pick<S3StorageConfig, 'endpoint' | 'region' | 'publicUrl'>

  constructor(config: S3StorageConfig) {
    const mod = loadS3Module()
    this.PutObjectCommand = mod.PutObjectCommand
    this.DeleteObjectCommand = mod.DeleteObjectCommand
    this.config = {
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.endpoint  !== undefined ? { endpoint:  config.endpoint  } : {}),
      ...(config.region    !== undefined ? { region:    config.region    } : {}),
      ...(config.publicUrl !== undefined ? { publicUrl: config.publicUrl } : {}),
    }

    const clientCfg: Record<string, unknown> = {
      region: config.region ?? 'auto',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }
    if (config.endpoint) {
      clientCfg['endpoint'] = config.endpoint
      // Path-style addressing is the safe default for non-AWS endpoints (R2, MinIO).
      clientCfg['forcePathStyle'] = true
    }
    this.client = new mod.S3Client(clientCfg)
  }

  async upload(file: UploadInput): Promise<UploadOutput> {
    const key = generateKey(file.filename)
    const cmd = new this.PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimeType,
    })
    await this.client.send(cmd)
    return { key, url: this.getUrl(key) }
  }

  async delete(key: string): Promise<void> {
    const cmd = new this.DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    })
    await this.client.send(cmd)
  }

  getUrl(key: string): string {
    if (this.config.publicUrl) {
      return `${stripTrailingSlash(this.config.publicUrl)}/${key}`
    }
    if (this.config.endpoint) {
      return `${stripTrailingSlash(this.config.endpoint)}/${this.config.bucket}/${key}`
    }
    const region = this.config.region ?? 'us-east-1'
    return `https://${this.config.bucket}.s3.${region}.amazonaws.com/${key}`
  }
}
