import type { Context } from 'hono'
import type { DataStore } from '../types/store.js'

export interface HandlerContext {
  input: Record<string, unknown>
  ctx: Context
  store: DataStore
  services: Record<string, unknown>
}

/** Return void to continue, throw to cancel the operation. */
export type HandlerFn = (context: HandlerContext) => Promise<Response | void> | Response | void
