import type { ZeroAPISpec } from '../types/spec.js'

export interface EnvValidationResult {
  valid: boolean
  missing: string[]
}

/**
 * Validates that all required environment variables are present.
 * Checks spec.requiredEnv[] and built-in rules (e.g. JWT auth needs a secret).
 */
export function validateEnv(spec: ZeroAPISpec): EnvValidationResult {
  const missing: string[] = []

  for (const varName of spec.requiredEnv ?? []) {
    if (!process.env[varName]) missing.push(varName)
  }

  if (spec.auth?.strategy === 'jwt' && !spec.auth.secret && !process.env['JWT_SECRET']) {
    missing.push('JWT_SECRET')
  }

  return { valid: missing.length === 0, missing }
}

/**
 * Like validateEnv but throws immediately with a descriptive error listing
 * all missing variables. Call this at startup to fail fast.
 */
export function assertEnv(spec: ZeroAPISpec): void {
  const { valid, missing } = validateEnv(spec)
  if (!valid) {
    throw new Error(
      `[ZeroAPI] Missing required environment variables:\n` +
      missing.map((v) => `  • ${v}`).join('\n')
    )
  }
}
