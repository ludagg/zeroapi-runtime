import type { FieldDefinition } from '../types/spec.js'
import { uploadLocal } from './providers/local.js'
import type { LocalUploadResult } from './providers/local.js'

export type UploadProvider = 'local' | 's3' | 'r2'

export interface UploadError {
  field: string
  message: string
}

export interface UploadResult {
  /** Public URL or presigned URL for the uploaded file. */
  url: string
  filename: string
  size: number
  mimeType: string
}

// ── Validation ────────────────────────────────────────────────────────────────

const SIZE_UNITS: Record<string, number> = {
  b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3,
}

export function parseMaxSize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(raw.trim())
  if (!match) return 10 * 1024 * 1024  // 10 MB default
  const [, num, unit] = match
  return parseFloat(num!) * (SIZE_UNITS[unit!.toLowerCase()] ?? 1)
}

export function validateFile(file: File, field: FieldDefinition): UploadError | null {
  if (field.accept && field.accept.length > 0) {
    const allowed = field.accept.map((t) => t.toLowerCase())
    if (!allowed.includes(file.type.toLowerCase())) {
      return {
        field: field.type,
        message: `MIME type "${file.type}" not allowed. Accepted: ${field.accept.join(', ')}`,
      }
    }
  }
  if (field.maxSize) {
    const maxBytes = parseMaxSize(field.maxSize)
    if (file.size > maxBytes) {
      return {
        field: field.type,
        message: `File size ${file.size} bytes exceeds maximum of ${field.maxSize}`,
      }
    }
  }
  return null
}

// ── Upload orchestrator ───────────────────────────────────────────────────────

/**
 * Uploads a file using the provider configured on the field definition.
 * Falls back to local storage when no provider is specified.
 */
export async function uploadFile(
  file: File,
  field: FieldDefinition,
  uploadDir = './uploads'
): Promise<UploadResult> {
  const provider: UploadProvider = field.storage ?? 'local'

  switch (provider) {
    case 'local': {
      const result: LocalUploadResult = await uploadLocal(file, uploadDir)
      return result
    }
    case 's3':
    case 'r2': {
      // In a live deployment, credentials come from env vars.
      // For the runtime we return a placeholder signed URL so the flow can be tested.
      const region = process.env['AWS_REGION'] ?? 'us-east-1'
      const bucket = process.env['AWS_BUCKET'] ?? 'zeroapi-uploads'
      const key    = `${Date.now()}-${file.name}`
      const { generatePresignedPutUrl } = await import('./providers/s3.js')
      const result = generatePresignedPutUrl(key, {
        bucket,
        region,
        accessKeyId:     process.env['AWS_ACCESS_KEY_ID']     ?? 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        endpoint: provider === 'r2' ? process.env['R2_ENDPOINT'] : undefined,
      })
      return { url: result.fileUrl, filename: key, size: file.size, mimeType: file.type }
    }
  }
}

/**
 * Processes all file fields in a parsed multipart body.
 * Returns the body with file fields replaced by their stored URLs.
 */
export async function processFileFields(
  formData: Record<string, File | string | File[] | string[]>,
  fieldDefs: Record<string, FieldDefinition>,
  uploadDir = './uploads'
): Promise<{ body: Record<string, unknown>; errors: UploadError[] }> {
  const body: Record<string, unknown> = {}
  const errors: UploadError[] = []

  for (const [key, value] of Object.entries(formData)) {
    const fieldDef = fieldDefs[key]

    if (value instanceof File) {
      if (!fieldDef || fieldDef.type !== 'file') {
        body[key] = value.name  // non-declared file field — store name
        continue
      }
      const validationError = validateFile(value, fieldDef)
      if (validationError) { errors.push({ ...validationError, field: key }); continue }
      const result = await uploadFile(value, fieldDef, uploadDir)
      body[key] = result.url
    } else if (Array.isArray(value)) {
      const files = value.filter((v): v is File => v instanceof File)
      if (files.length > 0 && fieldDef?.type === 'file') {
        const urls: string[] = []
        for (const f of files) {
          const validationError = validateFile(f, fieldDef)
          if (validationError) { errors.push({ ...validationError, field: key }); continue }
          const result = await uploadFile(f, fieldDef, uploadDir)
          urls.push(result.url)
        }
        body[key] = urls
      } else {
        body[key] = value
      }
    } else {
      body[key] = value
    }
  }

  return { body, errors }
}
