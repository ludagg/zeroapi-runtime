import { describe, it, expect } from 'vitest'
import { generateZodSchemas } from '../../src/generators/validation.js'
import type { ResourceDefinition } from '../../src/types/spec.js'

const userResource: ResourceDefinition = {
  name: 'User',
  fields: {
    name: { type: 'string', required: true, minLength: 2, maxLength: 50 },
    email: { type: 'email', required: true, unique: true },
    age: { type: 'integer', required: false, min: 0, max: 150 },
    bio: { type: 'text', required: false },
    active: { type: 'boolean', required: false },
  },
}

describe('generateZodSchemas', () => {
  it('returns create and update schemas', () => {
    const schemas = generateZodSchemas(userResource)
    expect(schemas.create).toBeDefined()
    expect(schemas.update).toBeDefined()
  })

  describe('create schema', () => {
    it('accepts valid data', () => {
      const { create } = generateZodSchemas(userResource)
      const result = create.safeParse({ name: 'Alice', email: 'alice@example.com' })
      expect(result.success).toBe(true)
    })

    it('rejects missing required fields', () => {
      const { create } = generateZodSchemas(userResource)
      const result = create.safeParse({ name: 'Alice' })
      expect(result.success).toBe(false)
    })

    it('rejects invalid email', () => {
      const { create } = generateZodSchemas(userResource)
      const result = create.safeParse({ name: 'Alice', email: 'not-an-email' })
      expect(result.success).toBe(false)
    })

    it('enforces string minLength', () => {
      const { create } = generateZodSchemas(userResource)
      const result = create.safeParse({ name: 'A', email: 'a@b.com' })
      expect(result.success).toBe(false)
    })

    it('enforces integer bounds', () => {
      const { create } = generateZodSchemas(userResource)
      const result = create.safeParse({ name: 'Alice', email: 'a@b.com', age: 200 })
      expect(result.success).toBe(false)
    })
  })

  describe('update schema', () => {
    it('accepts empty body (all fields optional)', () => {
      const { update } = generateZodSchemas(userResource)
      const result = update.safeParse({})
      expect(result.success).toBe(true)
    })

    it('accepts partial updates', () => {
      const { update } = generateZodSchemas(userResource)
      const result = update.safeParse({ name: 'Bob' })
      expect(result.success).toBe(true)
    })

    it('still validates types when field is provided', () => {
      const { update } = generateZodSchemas(userResource)
      const result = update.safeParse({ email: 'bad-email' })
      expect(result.success).toBe(false)
    })
  })

  describe('type coverage', () => {
    it('handles all field types without error', () => {
      const resource: ResourceDefinition = {
        name: 'AllTypes',
        fields: {
          a: { type: 'string', required: true },
          b: { type: 'text', required: true },
          c: { type: 'number', required: true },
          d: { type: 'integer', required: true },
          e: { type: 'boolean', required: true },
          f: { type: 'date', required: true },
          g: { type: 'datetime', required: true },
          h: { type: 'email', required: true },
          i: { type: 'url', required: true },
          j: { type: 'uuid', required: true },
        },
      }
      expect(() => generateZodSchemas(resource)).not.toThrow()
    })
  })
})
