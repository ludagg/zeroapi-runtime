import { createRequire } from 'node:module'
import { PrismaWebhookStore, type PrismaWebhookLikeClient } from './prisma-store.js'
import type { WebhookStore } from './store.js'

declare const require: NodeRequire | undefined

/**
 * Resolves a Node `require` that works in both module systems (mirrors the
 * other Prisma autodetectors).
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
 * Attempts to instantiate a `PrismaWebhookStore` automatically. Returns `null`
 * when Prisma is unavailable (missing module, no `DATABASE_URL`, broken client),
 * exactly like `tryAutoLoadPrismaApiKeyStore` — the caller falls back to memory.
 */
export function tryAutoLoadPrismaWebhookStore(): WebhookStore | null {
  if (!process.env['DATABASE_URL']) return null
  const req = resolveRequire()
  if (!req) return null
  try {
    const mod = req('@prisma/client') as { PrismaClient?: new () => PrismaWebhookLikeClient }
    if (!mod?.PrismaClient) return null
    const client = new mod.PrismaClient()
    return new PrismaWebhookStore(client)
  } catch {
    return null
  }
}
