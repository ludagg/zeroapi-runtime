import { describe, it, expect } from 'vitest'
import { generateEnvExample } from '../../src/env/example.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const baseSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'shop-api',
  resources: [],
}

describe('generateEnvExample', () => {
  it('starts with a header carrying the spec name', () => {
    const body = generateEnvExample(baseSpec)
    expect(body).toContain(`# Variables d'environnement — shop-api`)
    expect(body.startsWith('# ===================================')).toBe(true)
  })

  it('marks required vars as REQUISE', () => {
    const body = generateEnvExample({
      ...baseSpec,
      env: [{ name: 'STRIPE_KEY', required: true, description: 'Stripe API key' }],
    })
    expect(body).toContain('# STRIPE_KEY (REQUISE)')
    expect(body).toContain('# Stripe API key')
    expect(body).toContain('STRIPE_KEY=\n')
  })

  it('marks generate:true vars with the "générée automatiquement" hint', () => {
    const body = generateEnvExample({
      ...baseSpec,
      env: [{ name: 'JWT_SECRET', required: true, generate: true, description: 'Secret JWT' }],
    })
    expect(body).toContain('# JWT_SECRET (REQUISE — générée automatiquement si absente)')
  })

  it('marks non-required vars as optionnelle', () => {
    const body = generateEnvExample({
      ...baseSpec,
      env: [{ name: 'SENTRY_DSN', required: false, description: 'Sentry DSN' }],
    })
    expect(body).toContain('# SENTRY_DSN (optionnelle)')
  })

  it('includes the example line when provided', () => {
    const body = generateEnvExample({
      ...baseSpec,
      env: [
        {
          name: 'DATABASE_URL',
          required: true,
          description: 'URL PostgreSQL',
          example: 'postgresql://user:pass@host:5432/db',
        },
      ],
    })
    expect(body).toContain('# Exemple : postgresql://user:pass@host:5432/db')
  })

  it('emits implicit vars from enabled features', () => {
    const body = generateEnvExample({
      ...baseSpec,
      auth: { jwt: { enabled: true } },
    })
    expect(body).toContain('JWT_SECRET=')
    expect(body).toContain('JWT_SECRET (REQUISE — générée automatiquement si absente)')
  })

  it('orders explicit vars before implicit ones', () => {
    const body = generateEnvExample({
      ...baseSpec,
      auth: { jwt: { enabled: true } },
      env: [{ name: 'FIRST_ONE', required: true }],
    })
    const firstIdx = body.indexOf('FIRST_ONE=')
    const jwtIdx = body.indexOf('JWT_SECRET=')
    expect(firstIdx).toBeGreaterThan(-1)
    expect(jwtIdx).toBeGreaterThan(firstIdx)
  })
})
