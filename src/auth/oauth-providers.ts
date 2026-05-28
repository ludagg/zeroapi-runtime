import type { OAuthProviderName } from '../types/spec.js'

export interface OAuthUserInfo {
  /** Provider-side user identifier (sub for Google, id for GitHub). */
  providerId: string
  email: string
  /** Display name when the provider exposes one — not all do. */
  name?: string
}

export interface OAuthProviderDescriptor {
  /** Default OAuth scopes when none are supplied via the spec. */
  defaultScopes: string[]
  /** Build the authorization URL the user is redirected to for consent. */
  authorizationUrl(params: {
    clientId: string
    redirectUri: string
    state: string
    scopes: string[]
  }): string
  /** Exchange an authorization code for user info (server-side, never exposed). */
  exchangeCode(params: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
    fetchImpl?: typeof fetch
  }): Promise<OAuthUserInfo>
}

/** Marker class so callers can distinguish "not implemented" from other errors. */
export class OAuthNotImplementedError extends Error {
  constructor(provider: string) {
    super(`${provider} OAuth not yet implemented`)
    this.name = 'OAuthNotImplementedError'
  }
}

/** Generic network/provider error. Carries the upstream message when known. */
export class OAuthProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthProviderError'
  }
}

function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

async function postForm(
  url: string,
  body: Record<string, string>,
  accept: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: accept,
    },
    body: buildQuery(body),
  })
  if (!res.ok) {
    throw new OAuthProviderError(`Token endpoint returned HTTP ${res.status}`)
  }
  return res.json()
}

async function fetchJson(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'zeroapi-runtime',
    },
  })
  if (!res.ok) {
    throw new OAuthProviderError(`Provider API returned HTTP ${res.status}`)
  }
  return res.json()
}

// ── Google ───────────────────────────────────────────────────────────────────

const googleProvider: OAuthProviderDescriptor = {
  defaultScopes: ['openid', 'email', 'profile'],

  authorizationUrl({ clientId, redirectUri, state, scopes }) {
    const params = buildQuery({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      access_type: 'online',
      prompt: 'select_account',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
    const token = (await postForm(
      'https://oauth2.googleapis.com/token',
      {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      },
      'application/json',
      fetchImpl,
    )) as { access_token?: string; error?: string }

    if (!token.access_token) {
      throw new OAuthProviderError(token.error ?? 'Google did not return an access_token')
    }

    const profile = (await fetchJson(
      'https://openidconnect.googleapis.com/v1/userinfo',
      token.access_token,
      fetchImpl,
    )) as { sub?: string; email?: string; name?: string; email_verified?: boolean }

    if (!profile.sub || !profile.email) {
      throw new OAuthProviderError('Google userinfo response is missing sub or email')
    }
    return {
      providerId: profile.sub,
      email: profile.email,
      ...(profile.name !== undefined ? { name: profile.name } : {}),
    }
  },
}

// ── GitHub ───────────────────────────────────────────────────────────────────

const githubProvider: OAuthProviderDescriptor = {
  defaultScopes: ['user:email'],

  authorizationUrl({ clientId, redirectUri, state, scopes }) {
    const params = buildQuery({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      allow_signup: 'true',
    })
    return `https://github.com/login/oauth/authorize?${params}`
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
    const token = (await postForm(
      'https://github.com/login/oauth/access_token',
      {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      },
      'application/json',
      fetchImpl,
    )) as { access_token?: string; error?: string; error_description?: string }

    if (!token.access_token) {
      throw new OAuthProviderError(
        token.error_description ?? token.error ?? 'GitHub did not return an access_token',
      )
    }

    const profile = (await fetchJson(
      'https://api.github.com/user',
      token.access_token,
      fetchImpl,
    )) as { id?: number | string; email?: string | null; name?: string | null; login?: string }

    let email = profile.email ?? null
    if (!email) {
      // GitHub hides the email when "Keep my email addresses private" is on —
      // fetch the email list endpoint and pick the primary verified one.
      const emails = (await fetchJson(
        'https://api.github.com/user/emails',
        token.access_token,
        fetchImpl,
      )) as Array<{ email: string; primary?: boolean; verified?: boolean }>
      const primary = emails.find((e) => e.primary && e.verified)
      email = primary?.email ?? emails.find((e) => e.verified)?.email ?? null
    }

    if (profile.id === undefined || profile.id === null || !email) {
      throw new OAuthProviderError('GitHub profile is missing id or a verified email')
    }

    const displayName = profile.name ?? profile.login
    return {
      providerId: String(profile.id),
      email,
      ...(displayName ? { name: displayName } : {}),
    }
  },
}

// ── Apple (stub) ─────────────────────────────────────────────────────────────

const appleProvider: OAuthProviderDescriptor = {
  defaultScopes: ['name', 'email'],

  authorizationUrl() {
    throw new OAuthNotImplementedError('apple')
  },

  async exchangeCode() {
    throw new OAuthNotImplementedError('apple')
  },
}

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<OAuthProviderName, OAuthProviderDescriptor> = {
  google: googleProvider,
  github: githubProvider,
  apple: appleProvider,
}

export function getOAuthProvider(name: OAuthProviderName): OAuthProviderDescriptor {
  return REGISTRY[name]
}

export function isProviderImplemented(name: OAuthProviderName): boolean {
  return name !== 'apple'
}
