import type { Hono, Context, MiddlewareHandler } from 'hono'
import type { FileUploadFeature } from '../types/spec.js'
import type { StorageProvider } from './provider.js'

const DEFAULT_MAX_SIZE_MB = 10

export interface UploadRoutesOptions {
  /** Auth middleware mounted on each upload route when present. */
  authMiddleware?: MiddlewareHandler
}

function validateUpload(
  file: File,
  feature: FileUploadFeature,
): { status: 413 | 415; message: string } | null {
  if (file.size > feature.maxSizeMB * 1024 * 1024) {
    return { status: 413, message: `File too large (max ${feature.maxSizeMB} MB)` }
  }
  if (feature.allowedTypes.length > 0) {
    const allowed = feature.allowedTypes.map((t) => t.toLowerCase())
    const mime = (file.type ?? '').toLowerCase()
    const ok = allowed.some((a) => a === mime || matchWildcard(a, mime))
    if (!ok) {
      return {
        status: 415,
        message: `Unsupported file type. Allowed: ${feature.allowedTypes.join(', ')}`,
      }
    }
  }
  return null
}

function matchWildcard(pattern: string, mime: string): boolean {
  if (!pattern.endsWith('/*')) return false
  const prefix = pattern.slice(0, pattern.length - 1)
  return mime.startsWith(prefix)
}

/**
 * Mounts `POST /upload` and `DELETE /upload/:key`. The routes are gated by
 * `authMiddleware` when one is supplied.
 *
 * `POST /upload` (multipart/form-data, field name `file`):
 *   201 → { key, url }
 *   400 → no file
 *   413 → too large
 *   415 → MIME not allowed
 *
 * `DELETE /upload/:key`:
 *   204 → deleted
 *   400 → invalid key
 */
export function mountUploadRoutes(
  app: Hono,
  storage: StorageProvider,
  feature: FileUploadFeature,
  options: UploadRoutesOptions = {},
): void {
  const effective: FileUploadFeature = {
    enabled: feature.enabled,
    provider: feature.provider,
    maxSizeMB: feature.maxSizeMB > 0 ? feature.maxSizeMB : DEFAULT_MAX_SIZE_MB,
    allowedTypes: feature.allowedTypes,
  }

  const auth = options.authMiddleware

  const uploadHandler = async (c: Context) => {
    let formData: Record<string, unknown>
    try {
      formData = (await c.req.parseBody({ all: true })) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Failed to parse multipart body' }, 400)
    }

    const raw = formData['file']
    const file = Array.isArray(raw) ? raw[0] : raw
    if (!(file instanceof File)) {
      return c.json({ error: 'No file provided. Send the file under the "file" field.' }, 400)
    }

    const err = validateUpload(file, effective)
    if (err) return c.json({ error: err.message }, err.status)

    const buffer = Buffer.from(await file.arrayBuffer())
    const result = await storage.upload({
      buffer,
      filename: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
    })

    return c.json({ key: result.key, url: result.url }, 201)
  }

  const deleteHandler = async (c: Context) => {
    const key = c.req.param('key')
    if (!key) return c.json({ error: 'Missing key' }, 400)
    try {
      await storage.delete(key)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    return c.body(null, 204)
  }

  if (auth) {
    app.post('/upload', auth, uploadHandler)
    app.delete('/upload/:key', auth, deleteHandler)
  } else {
    app.post('/upload', uploadHandler)
    app.delete('/upload/:key', deleteHandler)
  }
}
