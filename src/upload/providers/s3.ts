import { createHmac, createHash } from 'crypto'

export interface S3Config {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Custom endpoint for R2 or MinIO: https://<account>.r2.cloudflarestorage.com */
  endpoint?: string
}

export interface PresignedUrlResult {
  /** Use this URL with HTTP PUT to upload the file directly. */
  uploadUrl: string
  /** Public URL of the file after successful upload. */
  fileUrl: string
  expiresAt: string
}

function hmac256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function hex256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function deriveKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac256(hmac256(hmac256(hmac256(`AWS4${secret}`, date), region), service), 'aws4_request')
}

/**
 * Generates an AWS Signature V4 presigned PUT URL for S3 or an S3-compatible store (R2, MinIO).
 * No SDK required — uses only Node.js crypto.
 */
export function generatePresignedPutUrl(
  key: string,
  config: S3Config,
  options: { expiresIn?: number; contentType?: string } = {}
): PresignedUrlResult {
  const { expiresIn = 3600, contentType = 'application/octet-stream' } = options

  const now = new Date()
  const amzDate  = now.toISOString().replace(/[:-]/g, '').split('.')[0]! + 'Z'
  const dateOnly = amzDate.slice(0, 8)

  const isCustomEndpoint = !!config.endpoint
  const host = isCustomEndpoint
    ? new URL(config.endpoint!).host
    : `${config.bucket}.s3.${config.region}.amazonaws.com`

  const credential = `${config.accessKeyId}/${dateOnly}/${config.region}/s3/aws4_request`

  const params = new URLSearchParams([
    ['X-Amz-Algorithm',     'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential',    credential],
    ['X-Amz-Date',          amzDate],
    ['X-Amz-Expires',       String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ])
  // URLSearchParams sorts alphabetically, which is required by V4
  const sortedParams = new URLSearchParams([...params.entries()].sort(([a], [b]) => a.localeCompare(b)))

  const canonicalRequest = [
    'PUT',
    `/${isCustomEndpoint ? `${config.bucket}/` : ''}${key}`,
    sortedParams.toString(),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateOnly}/${config.region}/s3/aws4_request`,
    hex256(canonicalRequest),
  ].join('\n')

  const signingKey = deriveKey(config.secretAccessKey, dateOnly, config.region, 's3')
  const signature  = hmac256(signingKey, stringToSign).toString('hex')

  sortedParams.set('X-Amz-Signature', signature)

  const basePath = isCustomEndpoint
    ? `${config.endpoint}/${config.bucket}/${key}`
    : `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`

  const uploadUrl = `https://${host}/${isCustomEndpoint ? `${config.bucket}/` : ''}${key}?${sortedParams.toString()}`

  return {
    uploadUrl,
    fileUrl: basePath,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }
}
