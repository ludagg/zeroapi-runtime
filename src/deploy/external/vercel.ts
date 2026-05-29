import type { ZeroAPISpec } from '../../types/spec.js'

export interface VercelOptions {
  outputDirectory?: string
  installCommand?: string
  buildCommand?: string
  nodeVersion?: string
}

/**
 * Generates a vercel.json configuration for serverless deployment on Vercel.
 */
export function generateVercelConfig(
  spec: ZeroAPISpec,
  options: VercelOptions = {}
): string {
  const {
    outputDirectory = 'dist',
    installCommand = 'npm install',
    buildCommand = 'npm run build',
    nodeVersion = '22.x',
  } = options

  const config = {
    version: 2,
    $schema: 'https://openapi.vercel.sh/vercel.json',
    name: spec.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    installCommand,
    buildCommand,
    outputDirectory,
    framework: null as null,
    functions: {
      'dist/index.js': {
        runtime: `@vercel/node@${nodeVersion}`,
      },
    },
    routes: [
      { src: '/(.*)', dest: 'dist/index.js' },
    ],
    env: {
      NODE_ENV: 'production',
    },
  }

  return JSON.stringify(config, null, 2)
}

/**
 * Returns a Markdown "Deploy with Vercel" button for the given repository URL.
 */
export function getVercelDeployButton(repoUrl: string): string {
  const encoded = encodeURIComponent(repoUrl)
  return `[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=${encoded})`
}
