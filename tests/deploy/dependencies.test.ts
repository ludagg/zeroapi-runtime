import { describe, it, expect } from 'vitest'
import {
  generatePackageJson,
  getRequiredDependencies,
} from '../../src/deploy/dependencies.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const baseSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'deps-test',
  resources: [
    {
      name: 'Item',
      fields: { label: { type: 'string', required: true } },
    },
  ],
}

function s3Spec(provider: 's3' | 'r2' | 'local'): ZeroAPISpec {
  return {
    ...baseSpec,
    features: {
      fileUpload: { enabled: true, provider, maxSizeMB: 5, allowedTypes: [] },
    },
  }
}

describe('getRequiredDependencies — base', () => {
  it('always includes the runtime, hono, the node-server adapter, zod and the prisma client', () => {
    const deps = getRequiredDependencies(baseSpec)
    const names = deps.filter((d) => !d.dev).map((d) => d.name)
    expect(names).toContain('@ludagg/zeroapi-runtime')
    expect(names).toContain('hono')
    // The HTTP adapter that binds the port — without it `node dist/index.js`
    // crashes with "Cannot find module '@hono/node-server'".
    expect(names).toContain('@hono/node-server')
    expect(names).toContain('zod')
    expect(names).toContain('@prisma/client')
  })

  it('includes build tooling as dev dependencies', () => {
    const deps = getRequiredDependencies(baseSpec)
    const devNames = deps.filter((d) => d.dev).map((d) => d.name)
    expect(devNames).toContain('prisma')
    expect(devNames).toContain('typescript')
    expect(devNames).toContain('@types/node')
  })

  it('does NOT include @aws-sdk/client-s3 when there is no S3/R2 upload', () => {
    const deps = getRequiredDependencies(baseSpec)
    expect(deps.map((d) => d.name)).not.toContain('@aws-sdk/client-s3')
  })

  it('pins every dependency to a semver range', () => {
    for (const d of getRequiredDependencies(baseSpec)) {
      expect(d.version).toMatch(/^[\^~]?\d/)
    }
  })

  it('de-duplicates by name', () => {
    const names = getRequiredDependencies(s3Spec('s3')).map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('getRequiredDependencies — conditional S3/R2', () => {
  it('adds @aws-sdk/client-s3 as a runtime dependency for the s3 provider', () => {
    const deps = getRequiredDependencies(s3Spec('s3'))
    const aws = deps.find((d) => d.name === '@aws-sdk/client-s3')
    expect(aws).toBeDefined()
    expect(aws?.dev).toBe(false)
    expect(aws?.source).toBe('feature.fileUpload')
    expect(aws?.version).toMatch(/^\^3\./)
  })

  it('adds @aws-sdk/client-s3 for the r2 provider', () => {
    const deps = getRequiredDependencies(s3Spec('r2'))
    expect(deps.map((d) => d.name)).toContain('@aws-sdk/client-s3')
  })

  it('does NOT add @aws-sdk/client-s3 for the local provider', () => {
    const deps = getRequiredDependencies(s3Spec('local'))
    expect(deps.map((d) => d.name)).not.toContain('@aws-sdk/client-s3')
  })

  it('does NOT add @aws-sdk/client-s3 when fileUpload is disabled', () => {
    const spec: ZeroAPISpec = {
      ...baseSpec,
      features: {
        fileUpload: { enabled: false, provider: 's3', maxSizeMB: 5, allowedTypes: [] },
      },
    }
    expect(getRequiredDependencies(spec).map((d) => d.name)).not.toContain('@aws-sdk/client-s3')
  })
})

describe('generatePackageJson', () => {
  it('returns valid JSON ending with a newline', () => {
    const out = generatePackageJson(baseSpec)
    expect(out.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('lists @aws-sdk/client-s3 in dependencies when fileUpload provider is s3', () => {
    const pkg = JSON.parse(generatePackageJson(s3Spec('s3')))
    expect(pkg.dependencies['@aws-sdk/client-s3']).toBeDefined()
    expect(pkg.devDependencies['@aws-sdk/client-s3']).toBeUndefined()
  })

  it('lists @aws-sdk/client-s3 in dependencies when fileUpload provider is r2', () => {
    const pkg = JSON.parse(generatePackageJson(s3Spec('r2')))
    expect(pkg.dependencies['@aws-sdk/client-s3']).toBeDefined()
  })

  it('omits @aws-sdk/client-s3 from a spec without file upload', () => {
    const pkg = JSON.parse(generatePackageJson(baseSpec))
    expect(pkg.dependencies['@aws-sdk/client-s3']).toBeUndefined()
  })

  it('always carries the base runtime dependencies', () => {
    const pkg = JSON.parse(generatePackageJson(baseSpec))
    expect(pkg.dependencies['@ludagg/zeroapi-runtime']).toBeDefined()
    expect(pkg.dependencies['hono']).toBeDefined()
    expect(pkg.dependencies['@hono/node-server']).toBeDefined()
    expect(pkg.dependencies['zod']).toBeDefined()
    expect(pkg.dependencies['@prisma/client']).toBeDefined()
    expect(pkg.devDependencies['prisma']).toBeDefined()
  })

  it('derives a valid npm package name from the spec name', () => {
    const pkg = JSON.parse(generatePackageJson({ ...baseSpec, name: 'My Cool API!' }))
    expect(pkg.name).toBe('my-cool-api')
  })

  it('falls back to a default name when the spec name has no usable characters', () => {
    const pkg = JSON.parse(generatePackageJson({ ...baseSpec, name: '!!!' }))
    expect(pkg.name).toBe('zeroapi-app')
  })

  it('exposes build/start/db scripts and an engines floor', () => {
    const pkg = JSON.parse(generatePackageJson(baseSpec))
    expect(pkg.scripts.build).toBeDefined()
    expect(pkg.scripts.start).toBe('node dist/index.js')
    expect(pkg.scripts['db:push']).toContain('prisma')
    expect(pkg.engines.node).toBeDefined()
  })

  it('honours a custom version', () => {
    const pkg = JSON.parse(generatePackageJson(baseSpec, { version: '2.3.4' }))
    expect(pkg.version).toBe('2.3.4')
  })
})
