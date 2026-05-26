import { describe, it, expect } from 'vitest'
import { parseSpec, ParseError } from '../../src/parser/index.js'

describe('Relation parser validation', () => {
  it('accepts a valid manyToOne relation', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'api',
        resources: [
          { name: 'User', fields: { name: { type: 'string' } } },
          {
            name: 'Order', fields: { total: { type: 'number' } },
            relations: [{ type: 'manyToOne', resource: 'User', field: 'userId' }],
          },
        ],
      })
    ).not.toThrow()
  })

  it('rejects relation to unknown resource', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'api',
        resources: [
          {
            name: 'Order', fields: { total: { type: 'number' } },
            relations: [{ type: 'manyToOne', resource: 'NonExistentUser', field: 'userId' }],
          },
        ],
      })
    ).toThrow(ParseError)
  })

  it('rejects manyToMany without through field', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'api',
        resources: [
          { name: 'Product', fields: { name: { type: 'string' } } },
          {
            name: 'Order', fields: { total: { type: 'number' } },
            relations: [{ type: 'manyToMany', resource: 'Product' }],  // missing through
          },
        ],
      })
    ).toThrow(ParseError)
  })

  it('rejects duplicate through table name', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'api',
        resources: [
          { name: 'A', fields: { x: { type: 'string' } }, relations: [{ type: 'manyToMany', resource: 'B', through: 'ab_table' }] },
          { name: 'B', fields: { y: { type: 'string' } } },
          { name: 'C', fields: { z: { type: 'string' } }, relations: [{ type: 'manyToMany', resource: 'B', through: 'ab_table' }] },
        ],
      })
    ).toThrow(ParseError)
  })

  it('rejects circular required manyToOne (insertion deadlock)', () => {
    expect(() =>
      parseSpec({
        version: '1.0', name: 'api',
        resources: [
          { name: 'A', fields: { x: { type: 'string' } }, relations: [{ type: 'manyToOne', resource: 'B', required: true, field: 'bId' }] },
          { name: 'B', fields: { y: { type: 'string' } }, relations: [{ type: 'manyToOne', resource: 'A', required: true, field: 'aId' }] },
        ],
      })
    ).toThrow(ParseError)
  })
})
