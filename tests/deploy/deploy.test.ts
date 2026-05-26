import { describe, it, expect } from 'vitest'
import { generateRailwayConfig, getRailwayDeployButton } from '../../src/deploy/external/railway.js'
import { generateRenderConfig, getRenderDeployButton } from '../../src/deploy/external/render.js'
import { generateVercelConfig, getVercelDeployButton } from '../../src/deploy/external/vercel.js'
import { generateFlyConfig, getFlyDeployButton } from '../../src/deploy/external/flyio.js'
import { sampleSpec } from '../fixtures/sample-spec.js'

describe('Railway deploy', () => {
  it('generates a railway.toml string', () => {
    const config = generateRailwayConfig(sampleSpec)
    expect(typeof config).toBe('string')
    expect(config).toContain('[build]')
    expect(config).toContain('[deploy]')
  })

  it('includes spec name in a comment', () => {
    const config = generateRailwayConfig(sampleSpec)
    expect(config).toContain(sampleSpec.name)
  })

  it('uses custom start command when provided', () => {
    const config = generateRailwayConfig(sampleSpec, { startCommand: 'node server.js' })
    expect(config).toContain('node server.js')
  })

  it('deploy button is a Markdown image link', () => {
    const btn = getRailwayDeployButton('https://github.com/org/repo')
    expect(btn).toMatch(/!\[.*\]\(.*\)/)
    expect(btn).toContain('railway.app')
  })
})

describe('Render deploy', () => {
  it('generates a render.yaml string', () => {
    const config = generateRenderConfig(sampleSpec)
    expect(typeof config).toBe('string')
    expect(config).toContain('services:')
    expect(config).toContain('type: web')
  })

  it('sanitises service name from spec name', () => {
    const config = generateRenderConfig({ ...sampleSpec, name: 'My Cool API!' })
    expect(config).toContain('my-cool-api-')
  })

  it('deploy button is a Markdown image link', () => {
    const btn = getRenderDeployButton('https://github.com/org/repo')
    expect(btn).toMatch(/!\[.*\]\(.*\)/)
    expect(btn).toContain('render.com')
  })
})

describe('Vercel deploy', () => {
  it('generates valid JSON', () => {
    const config = generateVercelConfig(sampleSpec)
    expect(() => JSON.parse(config)).not.toThrow()
  })

  it('includes routes array', () => {
    const json = JSON.parse(generateVercelConfig(sampleSpec)) as { routes: unknown[] }
    expect(Array.isArray(json.routes)).toBe(true)
    expect(json.routes.length).toBeGreaterThan(0)
  })

  it('deploy button is a Markdown image link', () => {
    const btn = getVercelDeployButton('https://github.com/org/repo')
    expect(btn).toMatch(/!\[.*\]\(.*\)/)
    expect(btn).toContain('vercel.com')
  })
})

describe('Fly.io deploy', () => {
  it('generates a fly.toml string', () => {
    const config = generateFlyConfig(sampleSpec)
    expect(typeof config).toBe('string')
    expect(config).toContain('[http_service]')
    expect(config).toContain('[build]')
  })

  it('uses custom port when provided', () => {
    const config = generateFlyConfig(sampleSpec, { port: 8080 })
    expect(config).toContain('8080')
  })

  it('uses custom region', () => {
    const config = generateFlyConfig(sampleSpec, { region: 'fra' })
    expect(config).toContain('fra')
  })

  it('deploy button is a Markdown string', () => {
    const btn = getFlyDeployButton('my-app')
    expect(btn).toContain('fly.io')
    expect(btn).toContain('my-app')
  })
})
