import { cors } from 'hono/cors'
import type { MiddlewareHandler } from 'hono'
import type { CorsConfig } from '../types/spec.js'

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const DEFAULT_HEADERS = ['Content-Type', 'Authorization']

/**
 * Creates a CORS middleware configured from the spec's cors section.
 * When no config is provided, falls back to fully permissive defaults (dev-friendly).
 */
export function createCorsMiddleware(config?: CorsConfig): MiddlewareHandler {
  if (!config) {
    return cors()
  }

  return cors({
    origin: config.origins,
    allowMethods: config.methods ?? DEFAULT_METHODS,
    allowHeaders: config.headers ?? DEFAULT_HEADERS,
    credentials: config.credentials ?? false,
  })
}
