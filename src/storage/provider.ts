/**
 * Phase 3.2 — Storage abstraction.
 *
 * Unique interface used by the upload pipeline. Implementations live in
 * `local.ts` (filesystem) and `s3.ts` (S3 / R2 / S3-compatible).
 */

export interface UploadInput {
  buffer: Buffer
  filename: string
  mimeType: string
}

export interface UploadOutput {
  /** Opaque storage key — what gets persisted in the resource field. */
  key: string
  /** Public URL clients can use to fetch the file. */
  url: string
}

export interface StorageProvider {
  upload(file: UploadInput): Promise<UploadOutput>
  delete(key: string): Promise<void>
  getUrl(key: string): string
}
