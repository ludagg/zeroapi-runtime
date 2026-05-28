import type { Hono } from 'hono'
import type { GlobalAuthConfig, OAuthProviderConfig, OAuthProviderName } from '../types/spec.js'
import {
  generateAccessToken,
  generateRefreshTokenValue,
  hashRefreshToken,
  getAccessTokenTTL,
  getRefreshTokenTTL,
} from './jwt.js'
import type { UserRecord, UserStore } from './user-store.js'
import type { RefreshTokenStore } from './refresh-token-store.js'
import type { OAuthAccountStore } from './oauth-account-store.js'
import type { OAuthStateStore } from './oauth-state.js'
import {
  getOAuthProvider,
  isProviderImplemented,
  OAuthNotImplementedError,
  OAuthProviderError,
  type OAuthProviderDescriptor,
} from './oauth-providers.js'
import { buildOAuthCallbackUrl, readProviderCredentials } from './oauth-config.js'

export interface MountOAuthRoutesOptions {
  /** Base URL for callbacks (from `OAUTH_CALLBACK_BASE_URL`). When undefined the endpoints return 501. */
  baseUrl?: string
  /** Override `fetch` for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

function publicUser(u: UserRecord) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    emailVerified: u.emailVerified,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  }
}

function findProvider(config: GlobalAuthConfig, name: string): OAuthProviderConfig | null {
  return config.oauth?.providers.find((p) => p.name === name) ?? null
}

/**
 * Mounts `/auth/oauth/:provider` (initiate) and `/auth/oauth/:provider/callback`
 * (exchange + login) for each provider declared in `auth.oauth.providers`.
 *
 * Endpoints are mounted under generic path params so that providers with
 * missing credentials respond 501 *at request time* rather than at boot —
 * the operator can fill in env vars without restarting.
 */
export function mountOAuthRoutes(
  app: Hono,
  config: GlobalAuthConfig,
  jwtSecret: string,
  users: UserStore,
  refreshTokens: RefreshTokenStore,
  oauthAccounts: OAuthAccountStore,
  oauthState: OAuthStateStore,
  options: MountOAuthRoutesOptions = {},
): void {
  const accessTtlSec = getAccessTokenTTL(config)
  const refreshTtlSec = getRefreshTokenTTL(config)
  const fetchImpl = options.fetchImpl ?? fetch

  async function issueTokens(user: UserRecord): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = await generateAccessToken(user.id, user.email, user.role, jwtSecret, accessTtlSec)
    const refreshToken = generateRefreshTokenValue()
    await refreshTokens.create({
      tokenHash: hashRefreshToken(refreshToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + refreshTtlSec * 1000),
    })
    return { accessToken, refreshToken }
  }

  // ── GET /auth/oauth/:provider ────────────────────────────────────────────

  app.get('/auth/oauth/:provider', async (c) => {
    const name = c.req.param('provider')
    const provider = findProvider(config, name)
    if (!provider) {
      return c.json({ error: `Unknown OAuth provider "${name}"` }, 404)
    }
    if (!isProviderImplemented(provider.name)) {
      return c.json({ error: `OAuth ${provider.name} not yet implemented` }, 501)
    }
    if (!options.baseUrl) {
      return c.json(
        { error: `OAuth callback base URL is not configured (OAUTH_CALLBACK_BASE_URL)` },
        501,
      )
    }
    const { clientId, clientSecret } = readProviderCredentials(provider)
    if (!clientId || !clientSecret) {
      return c.json({ error: `OAuth ${provider.name} non configuré` }, 501)
    }

    const descriptor: OAuthProviderDescriptor = getOAuthProvider(provider.name)
    const redirectTo = c.req.query('redirectTo')
    const { state } = await oauthState.create(provider.name, redirectTo)
    const scopes = provider.scopes ?? descriptor.defaultScopes
    const redirectUri = buildOAuthCallbackUrl(options.baseUrl, provider.name)

    const url = descriptor.authorizationUrl({ clientId, redirectUri, state, scopes })
    return c.redirect(url, 302)
  })

  // ── GET /auth/oauth/:provider/callback ───────────────────────────────────

  app.get('/auth/oauth/:provider/callback', async (c) => {
    const name = c.req.param('provider')
    const provider = findProvider(config, name)
    if (!provider) {
      return c.json({ error: `Unknown OAuth provider "${name}"` }, 404)
    }
    if (!isProviderImplemented(provider.name)) {
      return c.json({ error: `OAuth ${provider.name} not yet implemented` }, 501)
    }
    if (!options.baseUrl) {
      return c.json(
        { error: `OAuth callback base URL is not configured (OAUTH_CALLBACK_BASE_URL)` },
        501,
      )
    }
    const { clientId, clientSecret } = readProviderCredentials(provider)
    if (!clientId || !clientSecret) {
      return c.json({ error: `OAuth ${provider.name} non configuré` }, 501)
    }

    const code = c.req.query('code')
    const state = c.req.query('state')
    const errorParam = c.req.query('error')

    if (errorParam) {
      return c.json({ error: `Provider returned error: ${errorParam}` }, 400)
    }
    if (!code) {
      return c.json({ error: 'Missing code parameter' }, 400)
    }
    if (!state) {
      return c.json({ error: 'Missing state parameter' }, 401)
    }

    const stored = await oauthState.consume(state)
    if (!stored || stored.provider !== provider.name) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 401)
    }

    const descriptor = getOAuthProvider(provider.name)
    const redirectUri = buildOAuthCallbackUrl(options.baseUrl, provider.name)

    let info: { providerId: string; email: string; name?: string }
    try {
      info = await descriptor.exchangeCode({
        clientId,
        clientSecret,
        code,
        redirectUri,
        fetchImpl,
      })
    } catch (e) {
      if (e instanceof OAuthNotImplementedError) {
        return c.json({ error: e.message }, 501)
      }
      const msg = e instanceof OAuthProviderError ? e.message : 'OAuth exchange failed'
      return c.json({ error: msg }, 502)
    }

    // 1. Existing OAuth link → log in.
    const existingLink = await oauthAccounts.findByProviderAndProviderId(provider.name, info.providerId)
    let user: UserRecord | null = existingLink
      ? await users.findById(existingLink.userId)
      : null

    // 2. No link but email already on file → link to that account (no duplicate).
    if (!user) {
      const byEmail = await users.findByEmail(info.email)
      if (byEmail) {
        user = byEmail
        await oauthAccounts.create({
          provider: provider.name,
          providerId: info.providerId,
          userId: user.id,
        })
      }
    }

    // 3. Brand new user.
    if (!user) {
      user = await users.createOAuth({
        email: info.email,
        role: 'user',
        emailVerified: true,
      })
      await oauthAccounts.create({
        provider: provider.name,
        providerId: info.providerId,
        userId: user.id,
      })
    }

    const { accessToken, refreshToken } = await issueTokens(user)

    if (stored.redirectTo) {
      // Append tokens as fragment so they don't end up in server logs / referrers.
      const sep = stored.redirectTo.includes('#') ? '&' : '#'
      const url = `${stored.redirectTo}${sep}accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`
      return c.redirect(url, 302)
    }

    return c.json({ data: { user: publicUser(user), accessToken, refreshToken } })
  })
}

/** Available providers as strings (filtered to those declared in the spec). */
export function listConfiguredOAuthProviderNames(config: GlobalAuthConfig): OAuthProviderName[] {
  return (config.oauth?.providers ?? []).map((p) => p.name)
}
