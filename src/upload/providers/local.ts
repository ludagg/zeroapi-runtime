import { writeFile, mkdir } from 'fs/promises'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'

export interface LocalUploadResult {
  url: string
  filename: string
  size: number
  mimeType: string
}

/**
 * Saves a File object to the local filesystem and returns the public URL path.
 */
export async function uploadLocal(
  file: File,
  uploadDir: string = './uploads'
): Promise<LocalUploadResult> {
  await mkdir(uploadDir, { recursive: true })

  const ext = extname(file.name) || mimeToExt(file.type)
  const filename = `${randomUUID()}${ext}`
  const fullPath = join(uploadDir, filename)

  const buffer = Buffer.from(await file.arrayBuffer())
  await writeFile(fullPath, buffer)

  return {
    url: `/uploads/${filename}`,
    filename,
    size: file.size,
    mimeType: file.type,
  }
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt', 'text/csv': '.csv',
    'application/json': '.json',
  }
  return map[mime] ?? ''
}
