import type { ZeroAPISpec, GlobalAuthConfig } from '../types/spec.js'
import type { JSONSchema } from './swagger.js'

/**
 * OpenAPI emission for the authentication endpoints that `createRuntime` mounts
 * automatically. Without this the generated `openapi.json` documents a
 * `bearerAuth` requirement on every resource path but never tells a client how
 * to obtain a token — the routes (`/auth/register`, `/auth/login`, …) exist at
 * runtime yet are invisible in the docs and the Playground.
 *
 * The detection here mirrors `src/runtime/index.ts` exactly so the document
 * never advertises a route the runtime didn't mount (or omits one it did):
 *   - JWT user system → `auth.jwt.enabled === true`
 *   - OAuth           → JWT system on AND `auth.oauth.providers` non-empty
 *   - API-key admin   → `auth.strategy === 'apikey'` || `auth.apikey.enabled`
 */

export function isJwtUserSystemEnabled(auth: GlobalAuthConfig | undefined): boolean {
  return auth?.jwt?.enabled === true
}

export function isOAuthEnabled(auth: GlobalAuthConfig | undefined): boolean {
  return isJwtUserSystemEnabled(auth) && (auth?.oauth?.providers?.length ?? 0) > 0
}

export function isApiKeyAdminEnabled(auth: GlobalAuthConfig | undefined): boolean {
  return auth?.strategy === 'apikey' || auth?.apikey?.enabled === true
}

// ── Shared component schemas ──────────────────────────────────────────────────

/**
 * Public user projection returned by the auth routes (`publicUser` in
 * jwt-routes.ts / oauth-routes.ts). Named `AuthUser` so it never collides with a
 * user-defined `User` schema — though when the JWT system is on the parser
 * already reserves the `User` resource name.
 */
const AUTH_USER_SCHEMA: JSONSchema = {
  type: 'object',
  description: 'Authenticated user (sensitive fields such as passwordHash are never exposed).',
  properties: {
    id:            { type: 'string', format: 'uuid' },
    email:         { type: 'string', format: 'email' },
    role:          { type: 'string' },
    emailVerified: { type: 'boolean' },
    createdAt:     { type: 'string', format: 'date-time' },
    updatedAt:     { type: 'string', format: 'date-time' },
  },
  required: ['id', 'email', 'role', 'emailVerified', 'createdAt', 'updatedAt'],
}

const ADMIN_API_KEY_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    id:         { type: 'string', format: 'uuid' },
    keyPrefix:  { type: 'string' },
    name:       { type: 'string', nullable: true },
    role:       { type: 'string' },
    revoked:    { type: 'boolean' },
    lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt:  { type: 'string', format: 'date-time' },
  },
  required: ['id', 'keyPrefix', 'role', 'createdAt'],
}

/** JSON-schema map of the components the auth paths reference. */
export function buildAuthSchemas(spec: ZeroAPISpec): Record<string, JSONSchema> {
  const auth = spec.auth
  const schemas: Record<string, JSONSchema> = {}
  if (isJwtUserSystemEnabled(auth) || isOAuthEnabled(auth)) {
    schemas['AuthUser'] = AUTH_USER_SCHEMA
  }
  if (isApiKeyAdminEnabled(auth)) {
    schemas['AdminApiKey'] = ADMIN_API_KEY_SCHEMA
  }
  return schemas
}

// ── Local response/body helpers ───────────────────────────────────────────────

function jsonBody(schema: JSONSchema): unknown {
  return { required: true, content: { 'application/json': { schema } } }
}

function jsonResponse(description: string, schema: JSONSchema): unknown {
  return { description, content: { 'application/json': { schema } } }
}

function errorResponse(description: string): unknown {
  return jsonResponse(description, {
    type: 'object',
    properties: { error: { type: 'string' } },
    required: ['error'],
  })
}

const AUTH_USER_REF: JSONSchema = { $ref: '#/components/schemas/AuthUser' } as unknown as JSONSchema

function dataWrapper(props: Record<string, JSONSchema>, required: string[]): JSONSchema {
  return {
    type: 'object',
    properties: { data: { type: 'object', properties: props, required } },
    required: ['data'],
  }
}

const ACCESS_TOKEN: JSONSchema = { type: 'string', description: 'Short-lived JWT access token.' }
const REFRESH_TOKEN: JSONSchema = { type: 'string', description: 'Opaque refresh token used at POST /auth/refresh.' }

// ── Path builders ─────────────────────────────────────────────────────────────

function jwtAuthPaths(): Record<string, Record<string, unknown>> {
  const credentialsBody = jsonBody({
    type: 'object',
    properties: {
      email:    { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8 },
    },
    required: ['email', 'password'],
  })

  const sessionResponse = dataWrapper(
    { user: AUTH_USER_REF, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN },
    ['user', 'accessToken', 'refreshToken'],
  )

  const refreshBody = jsonBody({
    type: 'object',
    properties: { refreshToken: REFRESH_TOKEN },
    required: ['refreshToken'],
  })

  return {
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        description: 'Creates a user account and returns an access/refresh token pair.',
        operationId: 'authRegister',
        security: [],
        requestBody: credentialsBody,
        responses: {
          '201': jsonResponse('Created', sessionResponse),
          '400': errorResponse('Invalid email or password'),
          '409': errorResponse('Email already registered'),
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in',
        description: 'Verifies credentials and returns an access/refresh token pair.',
        operationId: 'authLogin',
        security: [],
        requestBody: credentialsBody,
        responses: {
          '200': jsonResponse('OK', sessionResponse),
          '401': errorResponse('Invalid credentials'),
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Refresh tokens',
        description: 'Rotates the refresh token and issues a fresh access/refresh pair.',
        operationId: 'authRefresh',
        security: [],
        requestBody: refreshBody,
        responses: {
          '200': jsonResponse('OK', dataWrapper(
            { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN },
            ['accessToken', 'refreshToken'],
          )),
          '400': errorResponse('refreshToken is required'),
          '401': errorResponse('Invalid or expired refresh token'),
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Log out',
        description: 'Revokes the supplied refresh token. Always succeeds.',
        operationId: 'authLogout',
        security: [],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { refreshToken: REFRESH_TOKEN },
          } } },
        },
        responses: {
          '200': jsonResponse('OK', dataWrapper(
            { message: { type: 'string' } },
            ['message'],
          )),
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user',
        description: 'Returns the user identified by the bearer access token.',
        operationId: 'authMe',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': jsonResponse('OK', dataWrapper({ user: AUTH_USER_REF }, ['user'])),
          '401': errorResponse('Authentication required'),
        },
      },
    },
  }
}

function oauthPaths(): Record<string, Record<string, unknown>> {
  const providerParam = {
    name: 'provider',
    in: 'path',
    required: true,
    description: 'OAuth provider name (e.g. google, github, apple).',
    schema: { type: 'string' },
  }
  const sessionResponse = dataWrapper(
    { user: AUTH_USER_REF, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN },
    ['user', 'accessToken', 'refreshToken'],
  )
  return {
    '/auth/oauth/{provider}': {
      get: {
        tags: ['OAuth'],
        summary: 'Begin OAuth login',
        description: 'Redirects (302) to the provider\'s authorization screen.',
        operationId: 'authOAuthStart',
        security: [],
        parameters: [
          providerParam,
          { name: 'redirectTo', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '302': { description: 'Redirect to provider authorization URL' },
          '404': errorResponse('Unknown OAuth provider'),
          '501': errorResponse('Provider not implemented or not configured'),
        },
      },
    },
    '/auth/oauth/{provider}/callback': {
      get: {
        tags: ['OAuth'],
        summary: 'OAuth callback',
        description: 'Exchanges the authorization code for tokens. Returns the session JSON, or redirects with tokens in the URL fragment when redirectTo was supplied.',
        operationId: 'authOAuthCallback',
        security: [],
        parameters: [
          providerParam,
          { name: 'code',  in: 'query', required: false, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'error', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': jsonResponse('OK', sessionResponse),
          '302': { description: 'Redirect to redirectTo with tokens in the fragment' },
          '400': errorResponse('Missing code or provider error'),
          '401': errorResponse('Invalid or expired OAuth state'),
          '404': errorResponse('Unknown OAuth provider'),
          '501': errorResponse('Provider not implemented or not configured'),
          '502': errorResponse('OAuth exchange failed'),
        },
      },
    },
  }
}

function apiKeyAdminPaths(): Record<string, Record<string, unknown>> {
  const apiKeyRef: JSONSchema = { $ref: '#/components/schemas/AdminApiKey' } as unknown as JSONSchema
  const secured = [{ bearerAuth: [] }, { apiKeyAuth: [] }]
  return {
    '/admin/api-keys': {
      post: {
        tags: ['API Keys'],
        summary: 'Create an API key',
        description: 'Issues a new API key. The plaintext key is returned once and never again.',
        operationId: 'adminCreateApiKey',
        security: secured,
        requestBody: {
          required: false,
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { name: { type: 'string' }, role: { type: 'string' } },
          } } },
        },
        responses: {
          '201': jsonResponse('Created', dataWrapper(
            {
              id:        { type: 'string', format: 'uuid' },
              key:       { type: 'string', description: 'Plaintext key — shown only on creation.' },
              keyPrefix: { type: 'string' },
              name:      { type: 'string', nullable: true },
              role:      { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
            },
            ['id', 'key', 'keyPrefix', 'role', 'createdAt'],
          )),
          '401': errorResponse('Unauthorized'),
        },
      },
      get: {
        tags: ['API Keys'],
        summary: 'List API keys',
        operationId: 'adminListApiKeys',
        security: secured,
        responses: {
          '200': jsonResponse('OK', {
            type: 'object',
            properties: { data: { type: 'array', items: apiKeyRef } },
            required: ['data'],
          }),
          '401': errorResponse('Unauthorized'),
        },
      },
    },
    '/admin/api-keys/{id}': {
      delete: {
        tags: ['API Keys'],
        summary: 'Revoke an API key',
        operationId: 'adminRevokeApiKey',
        security: secured,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': jsonResponse('OK', dataWrapper(
            { id: { type: 'string' }, revoked: { type: 'boolean' } },
            ['id', 'revoked'],
          )),
          '401': errorResponse('Unauthorized'),
          '404': errorResponse('API key not found'),
        },
      },
    },
  }
}

/**
 * Builds the OpenAPI `paths` entries for every auth route the runtime mounts
 * for this spec. Returns an empty object when no auth feature is active.
 */
export function buildAuthPaths(spec: ZeroAPISpec): Record<string, Record<string, unknown>> {
  const auth = spec.auth
  let paths: Record<string, Record<string, unknown>> = {}
  if (isJwtUserSystemEnabled(auth)) paths = { ...paths, ...jwtAuthPaths() }
  if (isOAuthEnabled(auth))         paths = { ...paths, ...oauthPaths() }
  if (isApiKeyAdminEnabled(auth))   paths = { ...paths, ...apiKeyAdminPaths() }
  return paths
}

/** Tags introduced by the auth paths, in display order. */
export function buildAuthTags(spec: ZeroAPISpec): Array<{ name: string; description?: string }> {
  const auth = spec.auth
  const tags: Array<{ name: string; description?: string }> = []
  if (isJwtUserSystemEnabled(auth)) {
    tags.push({ name: 'Auth', description: 'User registration, login and token lifecycle.' })
  }
  if (isOAuthEnabled(auth)) {
    tags.push({ name: 'OAuth', description: 'Social login via configured OAuth providers.' })
  }
  if (isApiKeyAdminEnabled(auth)) {
    tags.push({ name: 'API Keys', description: 'Administer API keys.' })
  }
  return tags
}
