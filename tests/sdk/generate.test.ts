import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { generateSdk } from '../../src/sdk/generate.js'
import { sampleSpec, minimalSpec } from '../fixtures/sample-spec.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

// ── Spec fixtures used across tests ───────────────────────────────────────────

const shopSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'shop-api',
  resources: [
    {
      name: 'Product',
      fields: {
        title: { type: 'string', required: true },
        price: { type: 'decimal', required: true },
        inStock: { type: 'boolean', required: false },
        tags: { type: 'json', required: false },
      },
    },
    {
      name: 'Category',
      fields: {
        name: { type: 'string', required: true },
      },
    },
  ],
}

const jwtSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'auth-api',
  auth: { jwt: { enabled: true } },
  resources: [
    {
      name: 'Note',
      fields: { body: { type: 'text', required: true } },
    },
  ],
}

const relSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'blog-api',
  resources: [
    {
      name: 'User',
      fields: { email: { type: 'email', required: true } },
    },
    {
      name: 'Post',
      fields: {
        title: { type: 'string', required: true },
        userId: { type: 'uuid', required: true },
      },
      relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: true }],
    },
  ],
}

const fileSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'media-api',
  features: {
    fileUpload: { enabled: true, provider: 'local', maxSizeMB: 10, allowedTypes: ['image/png'] },
  },
  resources: [
    {
      name: 'Asset',
      fields: {
        name: { type: 'string', required: true },
        file: { type: 'file', required: true },
      },
    },
  ],
}

const enumSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'status-api',
  resources: [
    {
      name: 'Ticket',
      fields: {
        status: { type: 'enum', required: true, values: ['open', 'closed', 'pending'] },
      },
    },
  ],
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateSdk — class naming', () => {
  it('derives PascalCase class name and strips -api suffix', () => {
    const sdk = generateSdk(shopSpec)
    expect(sdk).toContain('export class ShopClient')
    expect(sdk).not.toContain('ShopApiClient')
  })

  it('handles snake_case and multi-word names', () => {
    const sdk = generateSdk({ ...shopSpec, name: 'my_cool-api' })
    expect(sdk).toContain('export class MyCoolClient')
  })

  it('falls back to the raw name when there is no -api suffix', () => {
    const sdk = generateSdk({ ...shopSpec, name: 'storefront' })
    expect(sdk).toContain('export class StorefrontClient')
  })
})

describe('generateSdk — types', () => {
  it('emits a full interface for each resource', () => {
    const sdk = generateSdk(shopSpec)
    expect(sdk).toContain('export interface Product')
    expect(sdk).toContain('export interface Category')
  })

  it('full interface includes id, createdAt, updatedAt', () => {
    const sdk = generateSdk(minimalSpec)
    expect(sdk).toMatch(/export interface Item\s*\{[\s\S]*id:\s*string[\s\S]*createdAt:\s*string[\s\S]*updatedAt:\s*string/)
  })

  it('CreateInput excludes id, createdAt, updatedAt', () => {
    const sdk = generateSdk(shopSpec)
    const block = sdk.match(/export interface CreateProductInput\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).not.toMatch(/\bid\b/)
    expect(block).not.toContain('createdAt')
    expect(block).not.toContain('updatedAt')
    expect(block).toContain('title')
    expect(block).toContain('price')
  })

  it('UpdateInput makes every field optional', () => {
    const sdk = generateSdk(shopSpec)
    const block = sdk.match(/export interface UpdateProductInput\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toMatch(/title\?:/)
    expect(block).toMatch(/price\?:/)
  })

  it('maps field types correctly', () => {
    const sdk = generateSdk({
      version: '1.0.0',
      name: 'type-api',
      resources: [{
        name: 'Sample',
        fields: {
          s:   { type: 'string',   required: true },
          t:   { type: 'text',     required: true },
          n:   { type: 'number',   required: true },
          i:   { type: 'integer',  required: true },
          d:   { type: 'decimal',  required: true },
          b:   { type: 'boolean',  required: true },
          dt:  { type: 'datetime', required: true },
          dy:  { type: 'date',     required: true },
          em:  { type: 'email',    required: true },
          uu:  { type: 'uuid',     required: true },
          js:  { type: 'json',     required: true },
          f:   { type: 'file',     required: true },
          fs:  { type: 'file[]',   required: true },
        },
      }],
    })
    const block = sdk.match(/export interface Sample\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toMatch(/s:\s*string/)
    expect(block).toMatch(/t:\s*string/)
    expect(block).toMatch(/n:\s*number/)
    expect(block).toMatch(/i:\s*number/)
    expect(block).toMatch(/d:\s*number/)
    expect(block).toMatch(/b:\s*boolean/)
    expect(block).toMatch(/dt:\s*string/)
    expect(block).toMatch(/dy:\s*string/)
    expect(block).toMatch(/em:\s*string/)
    expect(block).toMatch(/uu:\s*string/)
    expect(block).toMatch(/js:\s*unknown/)
    expect(block).toMatch(/f:\s*string/)
    expect(block).toMatch(/fs:\s*string\[\]/)
  })

  it('renders enum values as a union when provided', () => {
    const sdk = generateSdk(enumSpec)
    expect(sdk).toMatch(/status:\s*'open'\s*\|\s*'closed'\s*\|\s*'pending'/)
  })
})

describe('generateSdk — CRUD methods', () => {
  it('emits one accessor per resource with all CRUD methods by default', () => {
    const sdk = generateSdk(shopSpec)
    expect(sdk).toContain('products = {')
    expect(sdk).toContain('categories = {')
    // Each accessor exposes list/get/create/update/delete.
    const productsBlock = sdk.match(/products = \{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(productsBlock).toContain('list:')
    expect(productsBlock).toContain('get:')
    expect(productsBlock).toContain('create:')
    expect(productsBlock).toContain('update:')
    expect(productsBlock).toContain('delete:')
  })

  it('respects custom endpoints whitelist on a resource', () => {
    const sdk = generateSdk({
      version: '1.0.0',
      name: 'ro-api',
      resources: [{
        name: 'Stat',
        fields: { value: { type: 'integer', required: true } },
        endpoints: ['list', 'read'],
      }],
    })
    const block = sdk.match(/stats = \{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(block).toContain('list:')
    expect(block).toContain('get:')
    expect(block).not.toContain('create:')
    expect(block).not.toContain('update:')
    expect(block).not.toContain('delete:')
  })

  it('uses correct plural URL segment (categories, not categorys)', () => {
    const sdk = generateSdk(shopSpec)
    expect(sdk).toContain("'/categories'")
  })
})

describe('generateSdk — nested methods', () => {
  it('generates a nested accessor when a child has a manyToOne relation', () => {
    const sdk = generateSdk(relSpec)
    const usersBlock = sdk.match(/users = \{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(usersBlock).toContain('posts: {')
    // Nested URL points at the parent
    expect(usersBlock).toContain('/users/${encodeURIComponent(parentId)}')
  })

  it('does not generate a nested accessor on resources with no children', () => {
    const sdk = generateSdk(shopSpec)
    const productsBlock = sdk.match(/products = \{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(productsBlock).not.toContain('categories: {')
  })
})

describe('generateSdk — auth methods', () => {
  it('emits auth accessor when JWT is enabled', () => {
    const sdk = generateSdk(jwtSpec)
    expect(sdk).toContain('auth = {')
    expect(sdk).toContain('register:')
    expect(sdk).toContain('login:')
    expect(sdk).toContain('refresh:')
    expect(sdk).toContain('logout:')
    expect(sdk).toContain('me:')
    expect(sdk).toContain('/auth/register')
    expect(sdk).toContain('/auth/login')
  })

  it('does not emit auth when JWT is not enabled', () => {
    const sdk = generateSdk(shopSpec)
    expect(sdk).not.toContain("'/auth/register'")
    expect(sdk).not.toContain("'/auth/login'")
  })
})

describe('generateSdk — upload', () => {
  it('emits upload() method when fileUpload feature is enabled', () => {
    const sdk = generateSdk(fileSpec)
    expect(sdk).toContain('upload(file: File | Blob')
    expect(sdk).toContain("'/upload'")
  })

  it('emits upload() when a resource declares a file field even without features', () => {
    const sdk = generateSdk({
      version: '1.0.0',
      name: 'img-api',
      resources: [{
        name: 'Avatar',
        fields: {
          name: { type: 'string', required: true },
          file: { type: 'file', required: true },
        },
      }],
    })
    expect(sdk).toContain('upload(file: File | Blob')
  })

  it('does not emit upload() when no resource needs it', () => {
    const sdk = generateSdk(minimalSpec)
    expect(sdk).not.toContain('upload(file:')
  })
})

describe('generateSdk — ListParams and ApiError', () => {
  it('exports a ListParams<T> type', () => {
    const sdk = generateSdk(shopSpec)
    expect(sdk).toContain('export type ListParams<T>')
    expect(sdk).toContain('q?: string')
    expect(sdk).toContain('sort?:')
    expect(sdk).toContain('page?: number')
    expect(sdk).toContain('limit?: number')
    expect(sdk).toContain('include?: string[]')
  })

  it('exports an ApiError class that includes status and body', () => {
    const sdk = generateSdk(minimalSpec)
    expect(sdk).toContain('export class ApiError extends Error')
    expect(sdk).toContain('public status: number')
    expect(sdk).toContain('public body: unknown')
  })
})

describe('generateSdk — autonomy', () => {
  it('starts with the user-facing comment header', () => {
    const sdk = generateSdk(shopSpec)
    expect(sdk.startsWith('// SDK généré par ZeroAPI pour shop-api')).toBe(true)
    expect(sdk).toContain('Copie ce fichier dans ton projet et importe ShopClient')
  })

  it('uses native fetch and no external imports', () => {
    const sdk = generateSdk(shopSpec)
    expect(sdk).not.toContain('from \'')
    expect(sdk).not.toContain("require('")
    expect(sdk).toContain('fetch')
  })

  it('handles a minimal spec', () => {
    const sdk = generateSdk(minimalSpec)
    expect(sdk).toContain('export interface Item')
    expect(sdk).toContain('items = {')
    expect(sdk).toContain('export class MinimalClient')
  })
})

// ── End-to-end: the generated SDK actually compiles via tsc ───────────────────

describe('generateSdk — generated SDK compiles with tsc', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zeroapi-sdk-'))
  })

  function compile(spec: ZeroAPISpec, name: string): { ok: boolean; output: string } {
    const sdk = generateSdk(spec)
    const file = join(tmpDir, `${name}.ts`)
    writeFileSync(file, sdk, 'utf8')
    try {
      execSync(
        `npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022,DOM --skipLibCheck ${file}`,
        { encoding: 'utf8', stdio: 'pipe' },
      )
      return { ok: true, output: '' }
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
      const out = String(e.stdout ?? '') + String(e.stderr ?? '')
      return { ok: false, output: out }
    }
  }

  it('compiles the minimal spec SDK', () => {
    const result = compile(minimalSpec, 'minimal')
    if (!result.ok) console.error(result.output)
    expect(result.ok).toBe(true)
  })

  it('compiles the sample spec SDK', () => {
    const result = compile(sampleSpec, 'sample')
    if (!result.ok) console.error(result.output)
    expect(result.ok).toBe(true)
  })

  it('compiles the shop spec SDK', () => {
    const result = compile(shopSpec, 'shop')
    if (!result.ok) console.error(result.output)
    expect(result.ok).toBe(true)
  })

  it('compiles the JWT spec SDK', () => {
    const result = compile(jwtSpec, 'jwt')
    if (!result.ok) console.error(result.output)
    expect(result.ok).toBe(true)
  })

  it('compiles the relations spec SDK', () => {
    const result = compile(relSpec, 'rel')
    if (!result.ok) console.error(result.output)
    expect(result.ok).toBe(true)
  })

  it('compiles the file-upload spec SDK', () => {
    const result = compile(fileSpec, 'file')
    if (!result.ok) console.error(result.output)
    expect(result.ok).toBe(true)
  })

  it('compiles the enum spec SDK', () => {
    const result = compile(enumSpec, 'enum')
    if (!result.ok) console.error(result.output)
    expect(result.ok).toBe(true)
  })

  // Cleanup
  it('cleanup tmpdir', () => {
    rmSync(tmpDir, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})
