import { z } from 'zod'
import type { ResourceDefinition, FieldDefinition } from '../types/spec.js'

function fieldToZod(field: FieldDefinition): z.ZodTypeAny {
  let schema: z.ZodTypeAny

  switch (field.type) {
    case 'string':
    case 'text': {
      let s = z.string()
      if (field.minLength !== undefined) s = s.min(field.minLength)
      if (field.maxLength !== undefined) s = s.max(field.maxLength)
      schema = s
      break
    }
    case 'email':
      schema = z.string().email()
      break
    case 'url':
      schema = z.string().url()
      break
    case 'uuid':
      schema = z.string().uuid()
      break
    case 'number': {
      let n = z.number()
      if (field.min !== undefined) n = n.min(field.min)
      if (field.max !== undefined) n = n.max(field.max)
      schema = n
      break
    }
    case 'integer': {
      let n = z.number().int()
      if (field.min !== undefined) n = n.min(field.min)
      if (field.max !== undefined) n = n.max(field.max)
      schema = n
      break
    }
    case 'boolean':
      schema = z.boolean()
      break
    case 'date':
    case 'datetime':
      schema = z.string().datetime()
      break
    default:
      schema = z.unknown()
  }

  return field.required ? schema : schema.optional()
}

export interface ResourceSchemas {
  /** Schema for POST (create) — enforces required fields. */
  create: z.ZodObject<z.ZodRawShape>
  /** Schema for PUT (update) — all fields optional. */
  update: z.ZodObject<z.ZodRawShape>
}

// Server-managed fields: never validated against client input because they are
// auto-generated on create (id, createdAt, updatedAt) and re-issued on update.
const RESERVED_FIELDS = new Set(['id', 'createdAt', 'updatedAt'])

/**
 * Generates runtime Zod validation schemas for a resource.
 * The create schema mirrors field requirements; the update schema makes all fields optional.
 */
export function generateZodSchemas(resource: ResourceDefinition): ResourceSchemas {
  const createShape: z.ZodRawShape = {}
  const updateShape: z.ZodRawShape = {}

  for (const [name, field] of Object.entries(resource.fields)) {
    if (RESERVED_FIELDS.has(name)) continue
    createShape[name] = fieldToZod(field)
    updateShape[name] = fieldToZod({ ...field, required: false })
  }

  return {
    create: z.object(createShape),
    update: z.object(updateShape),
  }
}
