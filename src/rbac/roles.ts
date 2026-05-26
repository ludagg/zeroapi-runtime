import type { RoleDefinition } from '../types/spec.js'

/**
 * Resolves the full set of effective role names for a given role,
 * recursively walking the inheritance chain (cycle-safe).
 */
export function getEffectiveRoles(
  roleName: string,
  definitions: RoleDefinition[],
  visited = new Set<string>()
): string[] {
  if (visited.has(roleName)) return []
  visited.add(roleName)

  const effective = new Set<string>([roleName])
  const def = definitions.find((r) => r.name === roleName)

  if (def?.inherits) {
    for (const parent of def.inherits) {
      for (const r of getEffectiveRoles(parent, definitions, visited)) {
        effective.add(r)
      }
    }
  }

  return Array.from(effective)
}

/**
 * Extracts the user's role from the JWT payload in the Authorization header.
 * Does NOT verify the signature — call after the auth middleware has already verified.
 * Returns 'anonymous' when no valid role claim is found.
 */
export function extractRoleFromHeader(authHeader: string): string {
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return 'anonymous'

  const parts = token.split('.')
  if (parts.length !== 3) return 'anonymous'

  try {
    const raw = parts[1]
    if (!raw) return 'anonymous'
    const payload = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf-8')
    ) as { role?: string | string[] }

    if (Array.isArray(payload.role)) {
      return payload.role[0] ?? 'anonymous'
    }
    return payload.role ?? 'anonymous'
  } catch {
    return 'anonymous'
  }
}

/** Returns true if `roleName` (including inherited roles) is in `allowedRoles`. */
export function hasPermission(
  roleName: string,
  allowedRoles: string[],
  definitions: RoleDefinition[]
): boolean {
  if (allowedRoles.length === 0) return true
  const effective = getEffectiveRoles(roleName, definitions)
  return effective.some((r) => allowedRoles.includes(r))
}
