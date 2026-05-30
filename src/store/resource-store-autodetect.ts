import { createRequire } from 'node:module'
import type { PrismaResourceLikeClient } from './prisma-resource-store.js'

declare const require: NodeRequire | undefined

/**
 * Resolves a Node `require` that works in both module systems — identical to
 * the helper in `apikey-autodetect.ts`:
 * - CJS: the native `require` global.
 * - ESM: built from `import.meta.url` via `node:module#createRequire`.
 */
function resolveRequire(): NodeRequire | null {
  try {
    if (typeof require === 'function') return require
  } catch { /* `require` not in scope (strict ESM) */ }
  try {
    return createRequire(import.meta.url)
  } catch {
    return null
  }
}

/**
 * Attempts to instantiate a Prisma client for resource persistence, mirroring
 * `tryAutoLoadPrismaApiKeyStore`. Returns the raw client (so the caller can wrap
 * it with an in-memory fallback provider) or `null` when Prisma is unavailable.
 *
 * Conservative on purpose: only attempts when `DATABASE_URL` is set (the same
 * signal Prisma itself uses) and swallows every failure mode (missing module,
 * broken generator, connection issues).
 */
export function tryAutoLoadPrismaResourceClient(): PrismaResourceLikeClient | null {
  if (!process.env['DATABASE_URL']) return null
  const req = resolveRequire()
  if (!req) return null
  try {
    const mod = req('@prisma/client') as { PrismaClient?: new () => PrismaResourceLikeClient }
    if (!mod?.PrismaClient) return null
    return new mod.PrismaClient()
  } catch {
    return null
  }
}
