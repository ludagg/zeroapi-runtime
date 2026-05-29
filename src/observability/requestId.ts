import { randomUUID } from 'crypto'
import type { MiddlewareHandler } from 'hono'

export function createRequestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const id = c.req.header('x-request-id') ?? randomUUID()
    c.set('requestId', id)
    await next()
    c.header('x-request-id', id)
  }
}
