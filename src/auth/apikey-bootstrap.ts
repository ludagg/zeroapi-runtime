import type { GlobalAuthConfig } from '../types/spec.js'
import { generateApiKey } from './apikey.js'
import { MemoryApiKeyStore, type ApiKeyStore } from './apikey-store.js'

export interface BootstrapApiKeyResult {
  /** Set only when a fresh bootstrap key was generated on this call. */
  generated?: {
    id: string
    key: string
    keyPrefix: string
  }
}

export type BootstrapLogger = (line: string) => void

const DEFAULT_LOGGER: BootstrapLogger = (line) => console.log(line)

function resolvePrefix(config: GlobalAuthConfig): string {
  return config.apikey?.prefix ?? 'zak_live_'
}

function logBootstrap(log: BootstrapLogger, key: string): void {
  log('🔑 ZeroAPI — Clé API initiale :')
  log('   ' + key)
  log('   ⚠️ Sauvegardez-la, elle ne sera plus jamais affichée.')
}

/**
 * Synchronous bootstrap path for the built-in in-memory store. Returns
 * immediately so the runtime can guarantee the bootstrap key is available
 * before the first request reaches the auth middleware.
 */
export function bootstrapMemoryApiKeysSync(
  config: GlobalAuthConfig,
  store: MemoryApiKeyStore,
  log: BootstrapLogger = DEFAULT_LOGGER,
): BootstrapApiKeyResult {
  if (store.countSync() > 0) return {}

  const { key, keyHash, keyPrefix } = generateApiKey(resolvePrefix(config))
  const record = store.createSync({ keyHash, keyPrefix, name: 'bootstrap' })

  logBootstrap(log, key)
  return { generated: { id: record.id, key, keyPrefix: record.keyPrefix } }
}

/**
 * Generic async bootstrap — used when the store is backed by an external
 * database (e.g. Prisma). Mirrors the sync helper above.
 */
export async function bootstrapApiKeys(
  config: GlobalAuthConfig,
  store: ApiKeyStore,
  log: BootstrapLogger = DEFAULT_LOGGER,
): Promise<BootstrapApiKeyResult> {
  if ((await store.count()) > 0) return {}

  const { key, keyHash, keyPrefix } = generateApiKey(resolvePrefix(config))
  const record = await store.create({ keyHash, keyPrefix, name: 'bootstrap' })

  logBootstrap(log, key)
  return { generated: { id: record.id, key, keyPrefix: record.keyPrefix } }
}
