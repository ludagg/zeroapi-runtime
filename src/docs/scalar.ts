import type { Hono } from 'hono'

export interface ScalarConfig {
  /** Page title shown in the browser tab. */
  title?: string
  /** Scalar theme — see https://scalar.com/themes */
  theme?: 'default' | 'alternate' | 'moon' | 'purple' | 'solarized' | 'bluePlanet' | 'deepSpace' | 'saturn' | 'kepler' | 'elysiajs' | 'fastify' | 'none'
  /** Mount path. Defaults to "/docs". */
  path?: string
  /** OpenAPI JSON path. Defaults to "/openapi.json". */
  openApiPath?: string
}

/**
 * Renders the Scalar API reference page HTML, loading Scalar from CDN (no extra npm dep).
 */
export function renderScalarPage(openApiUrl: string, config: ScalarConfig = {}): string {
  const title = config.title ?? 'API Reference'
  const theme = config.theme ?? 'default'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
  <script
    id="api-reference"
    data-url="${openApiUrl}"
    data-configuration='${JSON.stringify({ theme, layout: "modern" })}'
  ></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`
}

/**
 * Mounts the Scalar docs UI and the OpenAPI JSON endpoint on the provided Hono app.
 *
 * @param app         - Hono application instance.
 * @param openApiJson - Pregenerated OpenAPI spec object (from generateOpenAPISpec).
 * @param config      - Optional Scalar display config.
 */
export function mountScalarDocs(
  app: Hono,
  openApiJson: unknown,
  config: ScalarConfig = {}
): void {
  const docsPath = config.path ?? '/docs'
  const openApiPath = config.openApiPath ?? '/openapi.json'

  app.get(openApiPath, (c) => c.json(openApiJson))
  app.get(docsPath, (c) => c.html(renderScalarPage(openApiPath, config)))
}
