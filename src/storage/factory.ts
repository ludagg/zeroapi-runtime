import type { FileUploadFeature } from '../types/spec.js'
import { LocalStorage, type LocalStorageOptions } from './local.js'
import { S3Storage, readS3ConfigFromEnv, hasS3EnvConfig } from './s3.js'
import type { StorageProvider } from './provider.js'

export type StorageBootLogger = (line: string) => void

export interface ResolveStorageOptions {
  /** Forwarded to LocalStorage when the resolved provider is local. */
  local?: LocalStorageOptions
  /** Receives diagnostic lines (warnings, info). Defaults to `console.warn`. */
  log?: StorageBootLogger
  /** Override `process.env['NODE_ENV']` — used by tests. */
  nodeEnv?: string
}

export const LOCAL_IN_PROD_WARNING =
  '⚠️  DANGER : stockage local en production.\n' +
  '   Sur un container éphémère (ZeroAPI Cloud), les fichiers seront PERDUS au redémarrage.\n' +
  '   Configure un provider S3/R2 pour la production.'

/**
 * Picks a `StorageProvider` from the spec's `features.fileUpload` block.
 *
 *  - `provider: "s3"` or `"r2"`  →  `S3Storage` (reads env vars)
 *  - `provider: "local"`         →  `LocalStorage`
 *  - provider unspecified        →  auto: `S3Storage` if env vars set, else `LocalStorage`
 *
 * When the resolved provider is `local` and `NODE_ENV=production` the function
 * logs a loud warning (it does NOT throw — some self-hosted deployments mount
 * a persistent disk and want this combination).
 */
export function resolveStorageProvider(
  feature: FileUploadFeature,
  options: ResolveStorageOptions = {},
): StorageProvider {
  const log = options.log ?? ((line: string) => console.warn(line))
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV']

  const declared = feature.provider
  // Auto-detection: when provider is local but the operator has S3 env vars
  // set, prefer S3 — they almost certainly meant to use it.
  let resolved: 's3' | 'r2' | 'local'
  if (declared === 's3' || declared === 'r2') {
    resolved = declared
  } else if (hasS3EnvConfig()) {
    resolved = 's3'
  } else {
    resolved = 'local'
  }

  if (resolved === 'local') {
    if (nodeEnv === 'production') log(LOCAL_IN_PROD_WARNING)
    return new LocalStorage(options.local ?? {})
  }

  const config = readS3ConfigFromEnv()
  return new S3Storage(config)
}
