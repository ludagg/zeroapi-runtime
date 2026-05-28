import { describe, it, expect } from 'vitest'
import {
  signPayload, verifySignature, generateWebhookSecret,
} from '../../src/webhooks/signature.js'

describe('signPayload', () => {
  it('produces a stable HMAC-SHA256 hex string', () => {
    const sig = signPayload('shh', '{"hello":"world"}')
    expect(sig).toMatch(/^[a-f0-9]{64}$/)
    // Same inputs → same output.
    expect(signPayload('shh', '{"hello":"world"}')).toBe(sig)
  })

  it('changes when the body changes', () => {
    const a = signPayload('shh', 'a')
    const b = signPayload('shh', 'b')
    expect(a).not.toBe(b)
  })

  it('changes when the secret changes', () => {
    const a = signPayload('one', 'body')
    const b = signPayload('two', 'body')
    expect(a).not.toBe(b)
  })
})

describe('verifySignature', () => {
  it('returns true for a correct signature', () => {
    const body = '{"order":42}'
    const sig = signPayload('secret', body)
    expect(verifySignature('secret', body, sig)).toBe(true)
  })

  it('returns false for a wrong signature', () => {
    expect(verifySignature('secret', 'body', 'deadbeef')).toBe(false)
  })

  it('returns false for null / undefined / empty', () => {
    expect(verifySignature('secret', 'body', null)).toBe(false)
    expect(verifySignature('secret', 'body', undefined)).toBe(false)
    expect(verifySignature('secret', 'body', '')).toBe(false)
  })

  it('uses constant-time compare (does not throw on length mismatch)', () => {
    expect(verifySignature('secret', 'body', 'abc')).toBe(false)
  })
})

describe('generateWebhookSecret', () => {
  it('produces a whsec_ prefixed 64-char hex secret', () => {
    const s = generateWebhookSecret()
    expect(s).toMatch(/^whsec_[a-f0-9]{64}$/)
  })

  it('generates unique secrets', () => {
    const a = generateWebhookSecret()
    const b = generateWebhookSecret()
    expect(a).not.toBe(b)
  })
})
