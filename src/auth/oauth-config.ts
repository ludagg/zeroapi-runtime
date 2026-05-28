import type { GlobalAuthConfig, OAuthProviderConfig, OAuthProviderName } from '../types/spec.js'

export const OAUTH_CALLBACK_BASE_ENV = 'OAUTH_CALLBACK_BASE_URL'

export interface OAuthCallbackUrl {
  provider: OAuthProviderName
  /** Full callback URL to register on the provider side. */
  url: string
  /** Human-friendly setup hint for documentation / dashboards. */
  message: string
}

export type OAuthWarningLogger = (line: string) => void

function stripTrailingSlash(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base
}

/** Builds the callback URL for a single provider. */
export function buildOAuthCallbackUrl(baseUrl: string, provider: OAuthProviderName): string {
  return `${stripTrailingSlash(baseUrl)}/auth/oauth/${provider}/callback`
}

/** Returns the callback URLs that need to be registered with each configured provider. */
export function getOAuthCallbackUrls(config: GlobalAuthConfig, baseUrl?: string): OAuthCallbackUrl[] {
  const providers = config.oauth?.providers ?? []
  const base = baseUrl ?? process.env[OAUTH_CALLBACK_BASE_ENV]
  if (!base || providers.length === 0) return []
  return providers.map((p) => ({
    provider: p.name,
    url: buildOAuthCallbackUrl(base, p.name),
    message:
      `Configure cette URL dans ta console ${p.name} : ${buildOAuthCallbackUrl(base, p.name)}`,
  }))
}

/**
 * Reads `OAUTH_CALLBACK_BASE_URL`. When OAuth is configured but the env var is
 * missing we emit a warning (not an error) — the runtime keeps booting, but the
 * OAuth init endpoint will respond 501 until the operator sets the var.
 */
export function resolveOAuthBaseUrl(
  config: GlobalAuthConfig,
  log: OAuthWarningLogger = (l) => console.warn(l),
): string | undefined {
  const providers = config.oauth?.providers ?? []
  const fromEnv = process.env[OAUTH_CALLBACK_BASE_ENV]
  if (fromEnv && fromEnv.length > 0) return fromEnv
  if (providers.length > 0) {
    log(
      `⚠️  ZeroAPI — ${OAUTH_CALLBACK_BASE_ENV} is not set but auth.oauth declares ` +
      `${providers.length} provider(s). OAuth endpoints will respond 501 until the variable is set.`,
    )
  }
  return undefined
}

/** Read clientId + clientSecret from the env vars declared in the spec. */
export function readProviderCredentials(provider: OAuthProviderConfig): {
  clientId?: string
  clientSecret?: string
} {
  const result: { clientId?: string; clientSecret?: string } = {}
  const id = process.env[provider.clientIdEnv]
  const secret = process.env[provider.clientSecretEnv]
  if (id && id.length > 0) result.clientId = id
  if (secret && secret.length > 0) result.clientSecret = secret
  return result
}
