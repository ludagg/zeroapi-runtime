import { createRequire } from 'node:module'
import { PrismaApiKeyStore, type PrismaLikeClient } from './prisma-apikey-store.js'
import type { ApiKeyStore } from './apikey-store.js'

declare const require: NodeRequire | undefined

/**
 * Resolves a Node `require` function that works in both module systems:
 * - CJS: the native `require` global is used directly.
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
 * Attempts to instantiate a `PrismaApiKeyStore` automatically. Returns `null`
 * when Prisma is unavailable in the current environment.
 *
 * Detection is intentionally conservative: we only try when `DATABASE_URL` is
 * set (the same signal Prisma itself uses) and we swallow every failure mode
 * (missing module, broken generator, connection problems) — the caller decides
 * what to do when we return null.
 */
export function tryAutoLoadPrismaApiKeyStore(): ApiKeyStore | null {
  if (!process.env['DATABASE_URL']) return null
  const req = resolveRequire()
  if (!req) return null
  try {
    const mod = req('@prisma/client') as { PrismaClient?: new () => PrismaLikeClient }
    if (!mod?.PrismaClient) return null
    const client = new mod.PrismaClient()
    return new PrismaApiKeyStore(client)
  } catch {
    return null
  }
}
