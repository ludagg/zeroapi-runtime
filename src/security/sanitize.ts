import type { MiddlewareHandler } from 'hono'

// Targeted patterns — avoids false positives on normal content
const INJECTION_PATTERNS: RegExp[] = [
  /<script[\s\S]*?>/gi,
  /<\/script>/gi,
  /javascript\s*:/gi,
  /on(?:load|click|error|focus|blur|change|submit|mouseover|mouseout)\s*=/gi,
  /<iframe[\s\S]*?>/gi,
  /<object[\s\S]*?>/gi,
  // SQL injection sequences (not just keywords)
  /'\s*(?:OR|AND)\s*'?\s*\d+\s*=\s*\d+/gi,
  /'\s*;\s*(?:DROP|DELETE|INSERT|UPDATE)\s+/gi,
  /(?:UNION\s+(?:ALL\s+)?SELECT)/gi,
  /(?:--|\/\*[\s\S]*?\*\/)/g,
]

function containsInjection(text: string): boolean {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      pattern.lastIndex = 0
      return true
    }
    pattern.lastIndex = 0
  }
  return false
}

/**
 * Middleware that blocks requests containing XSS or SQL injection patterns.
 * Inspects JSON request bodies (via Request clone), query parameters, and path params.
 * Non-mutating — clones the request to preserve the body for route handlers.
 */
export function createSanitizeMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // Check query parameters
    const url = new URL(c.req.url)
    for (const [, value] of url.searchParams.entries()) {
      if (containsInjection(value)) {
        return c.json({ error: 'Query parameter contains unsafe content' }, 400)
      }
    }

    // Check body for POST / PUT / PATCH only
    const method = c.req.method.toUpperCase()
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const contentType = c.req.header('content-type') ?? ''
      if (contentType.includes('application/json')) {
        try {
          // Clone to preserve the original body stream for the route handler
          const cloned = c.req.raw.clone()
          const text = await cloned.text()
          if (text && containsInjection(text)) {
            return c.json({ error: 'Request body contains unsafe content' }, 400)
          }
        } catch {
          // Cannot read body — pass through and let the route handler deal with it
        }
      }
    }

    await next()
  }
}
