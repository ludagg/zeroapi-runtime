import type { MiddlewareHandler } from 'hono'
import type { SecurityConfig } from '../types/spec.js'

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"

/**
 * Creates a middleware that sets security-hardening HTTP response headers.
 * All protections are enabled by default; pass a SecurityConfig to override.
 */
export function createHelmetMiddleware(config: SecurityConfig = {}): MiddlewareHandler {
  const {
    contentSecurityPolicy = true,
    hsts = true,
    noSniff = true,
    frameguard = 'DENY',
    xssProtection = true,
    referrerPolicy = 'strict-origin-when-cross-origin',
  } = config

  return async (c, next) => {
    if (contentSecurityPolicy) {
      c.header(
        'Content-Security-Policy',
        typeof contentSecurityPolicy === 'string' ? contentSecurityPolicy : DEFAULT_CSP
      )
    }
    if (hsts) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    if (noSniff) {
      c.header('X-Content-Type-Options', 'nosniff')
    }
    if (frameguard) {
      c.header('X-Frame-Options', frameguard === true ? 'DENY' : frameguard)
    }
    if (xssProtection) {
      c.header('X-XSS-Protection', '1; mode=block')
    }
    if (referrerPolicy) {
      c.header('Referrer-Policy', referrerPolicy)
    }
    c.header('X-Powered-By', 'ZeroAPI')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')

    await next()
  }
}
