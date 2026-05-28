import { createRequire } from 'node:module'
import { PrismaUserStore, type PrismaUserLikeClient } from './prisma-user-store.js'
import { PrismaRefreshTokenStore, type PrismaRefreshTokenLikeClient } from './prisma-refresh-token-store.js'
import type { UserStore } from './user-store.js'
import type { RefreshTokenStore } from './refresh-token-store.js'

declare const require: NodeRequire | undefined

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
 * Attempts to load a single Prisma client and wrap it into the pair of stores
 * needed by the JWT user system. Returns `null` when Prisma is unavailable;
 * the caller decides whether that's fatal (prod) or fine (dev fallback).
 */
export function tryAutoLoadPrismaJwtStores(): {
  userStore: UserStore
  refreshTokenStore: RefreshTokenStore
} | null {
  if (!process.env['DATABASE_URL']) return null
  const req = resolveRequire()
  if (!req) return null
  try {
    const mod = req('@prisma/client') as {
      PrismaClient?: new () => PrismaUserLikeClient & PrismaRefreshTokenLikeClient
    }
    if (!mod?.PrismaClient) return null
    const client = new mod.PrismaClient()
    return {
      userStore: new PrismaUserStore(client),
      refreshTokenStore: new PrismaRefreshTokenStore(client),
    }
  } catch {
    return null
  }
}
