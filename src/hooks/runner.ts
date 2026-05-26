import type { Context } from 'hono'
import type { DataStore } from '../types/store.js'
import type { HandlerFn } from './types.js'

/**
 * Executes a named hook if it exists in the handlers map.
 * Throws are propagated to the caller (caller decides how to respond).
 * Unknown hook IDs are silently ignored.
 */
export async function executeHook(
  hookId: string,
  handlers: Record<string, HandlerFn>,
  input: Record<string, unknown>,
  ctx: Context,
  store: DataStore
): Promise<void> {
  const fn = handlers[hookId]
  if (!fn) return
  await fn({ input, ctx, store, services: {} })
}
