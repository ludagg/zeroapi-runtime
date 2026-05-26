import { describe, it, expect } from 'vitest'
import { parseSpec, ParseError } from '../src/parser/index.js'
import { sampleSpec } from './fixtures/sample-spec.js'

describe('parseSpec', () => {
  it('accepts a valid spec', () => {
    const result = parseSpec(sampleSpec)
    expect(result.name).toBe('test-api')
    expect(result.version).toBe('1.0.0')
    expect(result.resources).toHaveLength(2)
  })

  it('throws ParseError for non-object input', () => {
    expect(() => parseSpec(null)).toThrow(ParseError)
    expect(() => parseSpec('string')).toThrow(ParseError)
    expect(() => parseSpec(42)).toThrow(ParseError)
  })

  it('throws ParseError when resources is empty', () => {
    expect(() =>
      parseSpec({ version: '1.0', name: 'api', resources: [] })
    ).toThrow(ParseError)
  })

  it('throws ParseError when resource has no fields', () => {
    expect(() =>
      parseSpec({
        version: '1.0',
        name: 'api',
        resources: [{ name: 'Empty', fields: {} }],
      })
    ).toThrow(ParseError)
  })

  it('throws ParseError for unknown field type', () => {
    expect(() =>
      parseSpec({
        version: '1.0',
        name: 'api',
        resources: [
          { name: 'Broken', fields: { x: { type: 'json' } } },
        ],
      })
    ).toThrow(ParseError)
  })

  it('throws ParseError for invalid baseUrl', () => {
    expect(() =>
      parseSpec({ version: '1.0', name: 'api', baseUrl: 'not-a-url', resources: [{ name: 'X', fields: { y: { type: 'string' } } }] })
    ).toThrow(ParseError)
  })

  it('includes human-readable details in the error message', () => {
    try {
      parseSpec({})
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError)
      expect((err as ParseError).message).toContain('Invalid ZeroAPI spec')
      expect((err as ParseError).details).toBeDefined()
    }
  })

  it('accepts all valid field types', () => {
    const types = ['string', 'text', 'number', 'integer', 'boolean', 'date', 'datetime', 'email', 'url', 'uuid'] as const
    for (const type of types) {
      expect(() =>
        parseSpec({
          version: '1.0',
          name: 'api',
          resources: [{ name: 'R', fields: { f: { type } } }],
        })
      ).not.toThrow()
    }
  })

  it('accepts spec with global auth config', () => {
    const result = parseSpec({
      version: '1.0',
      name: 'secured-api',
      auth: { strategy: 'jwt', secret: 'super-secret' },
      resources: [{ name: 'Item', fields: { name: { type: 'string' } } }],
    })
    expect(result.auth?.strategy).toBe('jwt')
  })
})
