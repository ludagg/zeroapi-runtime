import type { MiddlewareHandler } from 'hono'
import type { ZeroAPISpec } from '../types/spec.js'
import { extractRoleFromHeader, hasPermission } from './roles.js'

/**
 * Creates a Hono middleware that enforces role-based access control for a route.
 *
 * @param allowedRoles - Role names permitted to access this route. Empty = allow all.
 * @param spec         - The full spec, used to resolve role inheritance.
 */
export function createPermissionMiddleware(
  allowedRoles: string[],
  spec: ZeroAPISpec
): MiddlewareHandler {
  return async (c, next) => {
    if (allowedRoles.length === 0) {
      await next()
      return
    }

    const authHeader = c.req.header('Authorization') ?? ''
    if (!authHeader) {
      return c.json(
        { error: 'Authentication required — provide an Authorization header' },
        401
      )
    }

    const userRole = extractRoleFromHeader(authHeader)
    const definitions = spec.roles ?? []

    if (!hasPermission(userRole, allowedRoles, definitions)) {
      return c.json(
        {
          error: `Forbidden — role '${userRole}' is not permitted for this action`,
          required: allowedRoles,
        },
        403
      )
    }

    await next()
  }
}
