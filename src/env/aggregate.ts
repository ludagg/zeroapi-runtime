import type { ZeroAPISpec } from '../types/spec.js'

/** Where a variable came from: declared in spec.env, or pulled in by a feature. */
export type EnvVarSource =
  | 'explicit'
  | 'auth.jwt'
  | 'auth.oauth'
  | 'feature.fileUpload'
  | 'database'

/** A single environment variable with all metadata the platform needs. */
export interface AggregatedEnvVar {
  name: string
  required: boolean
  description?: string
  example?: string
  generate?: boolean
  managedByCloud?: boolean
  source: EnvVarSource
}

/**
 * Returns the complete list of environment variables the API depends on:
 * the explicit `spec.env` block merged with implicit variables required
 * by the features enabled in the spec (auth.jwt, auth.oauth, file uploads,
 * database). Duplicate names keep the first occurrence so an explicit
 * declaration always wins over an implicit one.
 */
export function getRequiredEnvVars(spec: ZeroAPISpec): AggregatedEnvVar[] {
  const result: AggregatedEnvVar[] = []
  const byName = new Map<string, AggregatedEnvVar>()

  const add = (v: AggregatedEnvVar): void => {
    if (byName.has(v.name)) return
    byName.set(v.name, v)
    result.push(v)
  }

  for (const e of spec.env ?? []) {
    add({
      name: e.name,
      required: e.required,
      ...(e.description !== undefined ? { description: e.description } : {}),
      ...(e.example !== undefined ? { example: e.example } : {}),
      ...(e.generate !== undefined ? { generate: e.generate } : {}),
      ...(e.managedByCloud !== undefined ? { managedByCloud: e.managedByCloud } : {}),
      source: 'explicit',
    })
  }

  const jwtEnabled =
    spec.auth?.jwt?.enabled === true || spec.auth?.strategy === 'jwt'
  if (jwtEnabled) {
    const secretEnv = spec.auth?.jwt?.secretEnv ?? 'JWT_SECRET'
    add({
      name: secretEnv,
      required: true,
      description: 'Secret used to sign JWT access tokens (HS256).',
      example: 'openssl rand -hex 32',
      generate: true,
      managedByCloud: true,
      source: 'auth.jwt',
    })
  }

  const providers = spec.auth?.oauth?.providers ?? []
  if (providers.length > 0) {
    add({
      name: 'OAUTH_CALLBACK_BASE_URL',
      required: true,
      description: 'Public base URL where OAuth callbacks are served (no trailing slash).',
      example: 'https://api.example.com',
      managedByCloud: true,
      source: 'auth.oauth',
    })
    for (const p of providers) {
      add({
        name: p.clientIdEnv,
        required: true,
        description: `OAuth client ID for the "${p.name}" provider.`,
        managedByCloud: true,
        source: 'auth.oauth',
      })
      add({
        name: p.clientSecretEnv,
        required: true,
        description: `OAuth client secret for the "${p.name}" provider.`,
        managedByCloud: true,
        source: 'auth.oauth',
      })
    }
  }

  const fu = spec.features?.fileUpload
  if (fu?.enabled && (fu.provider === 's3' || fu.provider === 'r2')) {
    const label = fu.provider === 'r2' ? 'Cloudflare R2' : 'S3'
    add({
      name: 'AWS_ACCESS_KEY_ID',
      required: true,
      description: `Access key ID for ${label} uploads.`,
      managedByCloud: true,
      source: 'feature.fileUpload',
    })
    add({
      name: 'AWS_SECRET_ACCESS_KEY',
      required: true,
      description: `Secret access key for ${label} uploads.`,
      managedByCloud: true,
      source: 'feature.fileUpload',
    })
    add({
      name: 'AWS_REGION',
      required: true,
      description: `Region where the ${label} bucket lives.`,
      example: 'us-east-1',
      managedByCloud: true,
      source: 'feature.fileUpload',
    })
    add({
      name: 'AWS_BUCKET',
      required: true,
      description: `Bucket name used by ${label} for uploads.`,
      managedByCloud: true,
      source: 'feature.fileUpload',
    })
    if (fu.provider === 'r2') {
      add({
        name: 'R2_ENDPOINT',
        required: true,
        description: 'Cloudflare R2 S3-compatible endpoint URL.',
        example: 'https://<account>.r2.cloudflarestorage.com',
        managedByCloud: true,
        source: 'feature.fileUpload',
      })
    }
  }

  // Database URL — always added to the metadata list so the platform can prompt
  // for it. Backwards compatibility: the runtime does NOT fail-fast on a
  // missing implicit DATABASE_URL; the legacy Prisma autodetect paths
  // (resolveApiKeyStore / resolveJwtStores) keep that responsibility.
  add({
    name: 'DATABASE_URL',
    required: true,
    description: 'PostgreSQL connection URL used by Prisma.',
    example: 'postgresql://user:pass@host:5432/db',
    managedByCloud: true,
    source: 'database',
  })

  return result
}
