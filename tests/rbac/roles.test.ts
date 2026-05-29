import { describe, it, expect } from 'vitest'
import { getEffectiveRoles, extractRoleFromHeader, hasPermission } from '../../src/rbac/roles.js'
import type { RoleDefinition } from '../../src/types/spec.js'

const roles: RoleDefinition[] = [
  { name: 'admin', inherits: ['moderator'] },
  { name: 'moderator', inherits: ['viewer'] },
  { name: 'viewer' },
  { name: 'editor' },
]

describe('getEffectiveRoles', () => {
  it('returns own role for a flat role', () => {
    const effective = getEffectiveRoles('viewer', roles)
    expect(effective).toContain('viewer')
    expect(effective).toHaveLength(1)
  })

  it('resolves one level of inheritance', () => {
    const effective = getEffectiveRoles('moderator', roles)
    expect(effective).toContain('moderator')
    expect(effective).toContain('viewer')
  })

  it('resolves transitive inheritance', () => {
    const effective = getEffectiveRoles('admin', roles)
    expect(effective).toContain('admin')
    expect(effective).toContain('moderator')
    expect(effective).toContain('viewer')
  })

  it('handles unknown role gracefully', () => {
    const effective = getEffectiveRoles('unknown', roles)
    expect(effective).toEqual(['unknown'])
  })

  it('is cycle-safe', () => {
    const cyclic: RoleDefinition[] = [
      { name: 'a', inherits: ['b'] },
      { name: 'b', inherits: ['a'] },
    ]
    expect(() => getEffectiveRoles('a', cyclic)).not.toThrow()
  })
})

describe('extractRoleFromHeader', () => {
  it('returns anonymous when header is empty', () => {
    expect(extractRoleFromHeader('')).toBe('anonymous')
  })

  it('returns anonymous for non-JWT token', () => {
    expect(extractRoleFromHeader('Bearer notavalidtoken')).toBe('anonymous')
  })

  it('extracts role from a valid JWT payload', () => {
    // Header.Payload.Signature (not verified here)
    const payload = Buffer.from(JSON.stringify({ sub: '1', role: 'admin' })).toString('base64url')
    const token = `header.${payload}.sig`
    expect(extractRoleFromHeader(`Bearer ${token}`)).toBe('admin')
  })

  it('handles array role claim (takes first)', () => {
    const payload = Buffer.from(JSON.stringify({ role: ['editor', 'viewer'] })).toString('base64url')
    const token = `h.${payload}.s`
    expect(extractRoleFromHeader(`Bearer ${token}`)).toBe('editor')
  })
})

describe('hasPermission', () => {
  it('returns true when allowedRoles is empty', () => {
    expect(hasPermission('viewer', [], roles)).toBe(true)
  })

  it('returns true for direct role match', () => {
    expect(hasPermission('admin', ['admin'], roles)).toBe(true)
  })

  it('returns true for inherited role match', () => {
    expect(hasPermission('admin', ['viewer'], roles)).toBe(true)
  })

  it('returns false for role without permission', () => {
    expect(hasPermission('viewer', ['admin'], roles)).toBe(false)
  })
})
