import { describe, it, expect } from 'vitest'
import { renderScalarPage, mountScalarDocs } from '../../src/docs/scalar.js'
import { Hono } from 'hono'

describe('renderScalarPage', () => {
  it('includes the openApiUrl as data-url', () => {
    const html = renderScalarPage('/openapi.json')
    expect(html).toContain('data-url="/openapi.json"')
  })

  it('includes the Scalar CDN script tag', () => {
    const html = renderScalarPage('/openapi.json')
    expect(html).toContain('@scalar/api-reference')
  })

  it('uses the provided title', () => {
    const html = renderScalarPage('/openapi.json', { title: 'My API Docs' })
    expect(html).toContain('My API Docs')
  })
})

describe('mountScalarDocs', () => {
  it('mounts /openapi.json and /docs on the app', async () => {
    const app = new Hono()
    mountScalarDocs(app, { openapi: '3.0.3', info: { title: 'test', version: '1' }, paths: {}, components: { schemas: {} } })

    const jsonRes = await app.request('/openapi.json')
    expect(jsonRes.status).toBe(200)
    expect(jsonRes.headers.get('content-type')).toContain('application/json')

    const docsRes = await app.request('/docs')
    expect(docsRes.status).toBe(200)
    expect(docsRes.headers.get('content-type')).toContain('text/html')
  })
})
