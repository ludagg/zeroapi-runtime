import type { Context, MiddlewareHandler } from 'hono'
import type {
  ZeroAPISpec,
  ResourceDefinition,
  PermissionAction,
  PermissionDefinition,
  PermissionRule,
} from '../types/spec.js'

const PUBLIC_ROLE = 'public'

/** Identity carried by an authenticated request, used by RBAC + ownership. */
export interface RequesterIdentity {
  /** Role name resolved from the JWT payload or the API-key record. */
  role: string
  /** Stable identifier for ownership checks. Only set for authenticated users. */
  userId?: string
  /** Full verified JWT claims, for scope rules reading arbitrary claims. */
  claims?: Record<string, unknown>
}

/**
 * Row-level scope surfaced to route handlers when a matched rule has ownOnly or
 * scope: rows are restricted to those where `column` equals `value`.
 * (ownOnly is the special case `{ column: 'userId', value: <sub> }`.)
 */
export interface OwnershipFilter {
  column: string
  value: string
}

/** Returns true when any auth strategy is activated on the spec. */
export function isAuthEnabled(spec: ZeroAPISpec): boolean {
  const auth = spec.auth
  if (!auth) return false
  if (auth.enabled === true) return true
  if (auth.strategy === 'jwt' || auth.strategy === 'apikey' || auth.strategy === 'bearer') return true
  if (auth.jwt?.enabled === true) return true
  if (auth.apikey?.enabled === true) return true
  if (Array.isArray(auth.strategies) && auth.strategies.length > 0) return true
  return false
}

function resolveApiKeyHeaderName(spec: ZeroAPISpec): string {
  return spec.auth?.apikey?.header ?? spec.auth?.header ?? 'x-api-key'
}

function getApiKeyContext(c: Context): { role?: unknown } | undefined {
  try { return c.get('apiKey') as { role?: unknown } | undefined } catch { return undefined }
}

function getUserContext(c: Context): { sub?: unknown; role?: unknown; claims?: unknown } | undefined {
  try { return c.get('user') as { sub?: unknown; role?: unknown; claims?: unknown } | undefined } catch { return undefined }
}

/**
 * Resolves the requester's role + userId (+ JWT claims) from whichever auth path
 * succeeded. Falls back to 'anonymous' when no auth context is present.
 */
export function getRequesterIdentity(c: Context): RequesterIdentity {
  const user = getUserContext(c)
  if (user && typeof user.sub === 'string') {
    return {
      role: typeof user.role === 'string' && user.role.length > 0 ? user.role : 'user',
      userId: user.sub,
      ...(user.claims && typeof user.claims === 'object'
        ? { claims: user.claims as Record<string, unknown> }
        : {}),
    }
  }
  const apiKey = getApiKeyContext(c)
  if (apiKey && typeof apiKey.role === 'string' && apiKey.role.length > 0) {
    return { role: apiKey.role }
  }
  return { role: 'anonymous' }
}

function findResourceDef(
  spec: ZeroAPISpec,
  resource: ResourceDefinition,
): PermissionDefinition | undefined {
  return spec.permissions?.find((p) => p.resource === resource.name)
}

function rulesForAction(def: PermissionDefinition, action: PermissionAction): PermissionRule[] {
  return def.rules.filter((r) => r.actions.includes(action))
}

function findRuleForRole(rules: PermissionRule[], role: string): PermissionRule | undefined {
  return rules.find((r) => r.role === role)
}

function publicRule(rules: PermissionRule[]): PermissionRule | undefined {
  return rules.find((r) => r.role === PUBLIC_ROLE)
}

function hasCredentials(c: Context, apiKeyHeader: string): boolean {
  return !!(c.req.header('Authorization') || c.req.header(apiKeyHeader))
}

async function runAuth(
  c: Context,
  authMiddleware: MiddlewareHandler,
): Promise<Response | undefined> {
  let passed = false
  const downstream = async (): Promise<void> => { passed = true }
  const result = await authMiddleware(c, downstream)
  if (!passed) {
    return result instanceof Response ? result : c.json({ error: 'Authentication required' }, 401)
  }
  return undefined
}

/**
 * Builds the RBAC guard for a (resource, action) pair using `spec.permissions`.
 *
 * Semantics:
 *   - When the spec defines no `permissions` block, returns null
 *     (callers fall back to legacy behaviour).
 *   - When auth is disabled globally, returns null (all endpoints public).
 *   - When a `permissions` block exists but does not cover this resource,
 *     fail-closed: require auth (no role check, just identity).
 *   - When rules exist for the resource:
 *       · credentials in the request are always consumed first, so an
 *         authenticated vendor lands in the vendor rule (with ownOnly)
 *         rather than the public rule, even if both grant the action.
 *       · "public" lets unauthenticated requests through.
 *       · a matched rule with ownOnly attaches an OwnershipFilter to the
 *         context so handlers can scope the operation to the owner's rows.
 */
export function buildResourcePermissionGuard(
  spec: ZeroAPISpec,
  resource: ResourceDefinition,
  action: PermissionAction,
  authMiddleware: MiddlewareHandler | undefined,
): MiddlewareHandler | null {
  if (!spec.permissions || spec.permissions.length === 0) return null
  if (!isAuthEnabled(spec)) return null

  const def = findResourceDef(spec, resource)
  const apiKeyHeader = resolveApiKeyHeaderName(spec)

  return async (c, next) => {
    // Resource not covered → fail-closed: require auth, no role check.
    if (!def) {
      if (!authMiddleware) return c.json({ error: 'Authentication required' }, 401)
      const err = await runAuth(c, authMiddleware)
      if (err) return err
      await next()
      return
    }

    const matchingRules = rulesForAction(def, action)
    if (matchingRules.length === 0) {
      // No rule grants this action → require auth and then 403.
      if (!authMiddleware) return c.json({ error: 'Authentication required' }, 401)
      const err = await runAuth(c, authMiddleware)
      if (err) return err
      return c.json(
        { error: `Forbidden — no role is permitted to "${action}" on ${resource.name}` },
        403,
      )
    }

    const pub = publicRule(matchingRules)

    // Credentials present → resolve identity and match a role-specific rule first.
    if (authMiddleware && hasCredentials(c, apiKeyHeader)) {
      let authed = false
      await authMiddleware(c, async () => { authed = true })

      if (authed) {
        const identity = getRequesterIdentity(c)
        const rule = findRuleForRole(matchingRules, identity.role)

        if (rule) {
          const ownership = resolveOwnership(rule, identity)
          if (ownership === 'missing-identity') {
            return c.json(
              { error: 'ownOnly rules require a user identity (JWT) — API keys cannot own rows' },
              403,
            )
          }
          if (ownership === 'missing-claim') {
            const claim = rule.scope?.claim ?? 'sub'
            return c.json(
              { error: `Forbidden — the request identity lacks the '${claim}' claim required to scope ${resource.name}` },
              403,
            )
          }
          if (ownership) c.set('ownershipFilter', ownership)
          await next()
          return
        }

        // Authenticated but role isn't covered → fall back to public if available.
        if (pub) {
          await next()
          return
        }
        return c.json(
          {
            error: `Forbidden — role '${identity.role}' is not permitted to "${action}" on ${resource.name}`,
          },
          403,
        )
      }

      // Credentials were supplied but invalid: if public is allowed, treat as anonymous;
      // otherwise propagate the 401.
      if (pub) {
        await next()
        return
      }
      return c.json({ error: 'Invalid or expired credentials' }, 401)
    }

    // No credentials presented.
    if (pub) {
      await next()
      return
    }
    return c.json({ error: 'Authentication required' }, 401)
  }
}

type OwnershipResolution = OwnershipFilter | undefined | 'missing-identity' | 'missing-claim'

/**
 * Resolves the row-level scope for a matched rule:
 *   - scope   → { column, value: <claim value> } (claim defaults to 'sub')
 *   - ownOnly → { column: 'userId', value: <sub> }
 *   - neither → undefined (no scoping)
 * Returns a sentinel when the required identity/claim is absent.
 */
function resolveOwnership(rule: PermissionRule, identity: RequesterIdentity): OwnershipResolution {
  if (rule.scope) {
    const claim = rule.scope.claim ?? 'sub'
    const raw = claim === 'sub' ? identity.userId : identity.claims?.[claim]
    if (raw === undefined || raw === null || raw === '') return 'missing-claim'
    return { column: rule.scope.column, value: String(raw) }
  }
  if (rule.ownOnly) {
    if (!identity.userId) return 'missing-identity'
    return { column: 'userId', value: identity.userId }
  }
  return undefined
}

/** Reads the OwnershipFilter previously set by the permission guard, if any. */
export function getOwnershipFilter(c: Context): OwnershipFilter | undefined {
  try { return c.get('ownershipFilter') as OwnershipFilter | undefined } catch { return undefined }
}

/** True when the resource has at least one ownOnly rule in the permissions block. */
export function resourceHasOwnOnly(spec: ZeroAPISpec, resourceName: string): boolean {
  return (spec.permissions ?? []).some(
    (p) => p.resource === resourceName && p.rules.some((r) => r.ownOnly),
  )
}
