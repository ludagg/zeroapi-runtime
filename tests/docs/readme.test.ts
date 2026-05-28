import { describe, it, expect } from 'vitest'
import { generateReadme } from '../../src/docs/readme.js'
import { generateEnvExample } from '../../src/env/example.js'
import { getRequiredEnvVars } from '../../src/env/aggregate.js'
import type { ZeroAPISpec } from '../../src/types/spec.js'

const minimalSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'minimal-api',
  resources: [
    {
      name: 'Item',
      fields: {
        label: { type: 'string', required: true },
      },
    },
  ],
}

const fullSpec: ZeroAPISpec = {
  version: '2.0.0',
  name: 'shop-api',
  description: 'API e-commerce générée par ZeroAPI.',
  baseUrl: 'https://api.shop.example',
  auth: {
    jwt: { enabled: true },
    apikey: { enabled: true, header: 'X-API-Key', prefix: 'shop_' },
    oauth: {
      providers: [
        { name: 'google', clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET' },
        { name: 'github', clientIdEnv: 'GITHUB_CLIENT_ID', clientSecretEnv: 'GITHUB_CLIENT_SECRET' },
      ],
    },
  },
  features: {
    fileUpload: {
      enabled: true,
      provider: 's3',
      maxSizeMB: 10,
      allowedTypes: ['image/png', 'image/jpeg'],
    },
    webhooks: {
      outbound: ['order.created', 'order.paid'],
      inbound: ['stripe'],
    },
    search: { enabled: true },
    pagination: { defaultLimit: 25, maxLimit: 200 },
  },
  permissions: [
    {
      resource: 'Product',
      rules: [
        { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
        { role: 'customer', actions: ['read'] },
      ],
    },
    {
      resource: 'Order',
      rules: [
        { role: 'customer', actions: ['create', 'read'], ownOnly: true },
      ],
    },
  ],
  relations: [
    { from: 'Order', to: 'Product', type: 'many-to-one', field: 'productId' },
  ],
  resources: [
    {
      name: 'Product',
      description: 'Articles vendus dans la boutique.',
      fields: {
        title: { type: 'string', required: true },
        price: { type: 'decimal', required: true },
        description: { type: 'text', required: false },
      },
    },
    {
      name: 'Order',
      fields: {
        productId: { type: 'uuid', required: true },
        quantity: { type: 'integer', required: true, min: 1 },
      },
      customEndpoints: [
        { method: 'POST', path: '/:id/refund', handler: 'refundOrder', auth: true, roles: ['admin'] },
      ],
    },
  ],
}

describe('generateReadme — minimal spec', () => {
  it('starts with the API name', () => {
    const md = generateReadme(minimalSpec)
    expect(md.startsWith('# minimal-api\n')).toBe(true)
  })

  it('includes the ZeroAPI mention', () => {
    expect(generateReadme(minimalSpec)).toContain('> Généré par ZeroAPI')
  })

  it('includes the quickstart steps in French', () => {
    const md = generateReadme(minimalSpec)
    expect(md).toContain('## 🚀 Démarrage rapide')
    expect(md).toContain('npm install')
    expect(md).toContain('npx prisma db push')
    expect(md).toContain('npm start')
  })

  it('lists endpoints derived from real resource names', () => {
    const md = generateReadme(minimalSpec)
    expect(md).toContain('### Item')
    expect(md).toContain('GET /items')
    expect(md).toContain('POST /items')
    expect(md).toContain('GET /items/:id')
    expect(md).toContain('PUT /items/:id')
    expect(md).toContain('DELETE /items/:id')
  })

  it('omits auth, upload, search and webhook sections when not configured', () => {
    const md = generateReadme(minimalSpec)
    expect(md).not.toContain('## 🔐 Authentification')
    expect(md).not.toContain('## 📎 Upload de fichiers')
    expect(md).not.toContain('## 🪝 Webhooks')
    expect(md).not.toContain('## 🔍 Recherche & filtres')
  })

  it('still includes DATABASE_URL in the env section', () => {
    const md = generateReadme(minimalSpec)
    expect(md).toContain('## ⚙️ Variables d\'environnement')
    expect(md).toContain('`DATABASE_URL`')
  })

  it('always includes deployment and interactive docs sections', () => {
    const md = generateReadme(minimalSpec)
    expect(md).toContain('## 🌍 Déploiement')
    expect(md).toContain('## 📖 Documentation interactive')
    expect(md).toContain('/openapi.json')
    expect(md).toContain('/health')
  })
})

describe('generateReadme — full spec', () => {
  it('renders the description block', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('API e-commerce générée par ZeroAPI.')
  })

  it('includes a JWT subsection when auth.jwt is enabled', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('## 🔐 Authentification')
    expect(md).toContain('### JWT')
    expect(md).toContain('POST /auth/register')
    expect(md).toContain('POST /auth/login')
    expect(md).toContain('POST /auth/refresh')
    expect(md).toContain('Authorization: Bearer')
  })

  it('includes an API key subsection with the configured header and prefix', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('### Clés API')
    expect(md).toContain('X-API-Key')
    expect(md).toContain('shop_')
    expect(md).toContain('bootstrap')
  })

  it('lists OAuth providers with their callback URLs', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('### OAuth')
    expect(md).toContain('**google**')
    expect(md).toContain('**github**')
    expect(md).toContain('https://api.shop.example/auth/oauth/google/callback')
    expect(md).toContain('https://api.shop.example/auth/oauth/github/callback')
    expect(md).toContain('OAUTH_CALLBACK_BASE_URL')
  })

  it('renders the env table with implicit JWT and S3 vars', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('| Variable | Requise | Description |')
    expect(md).toContain('`JWT_SECRET`')
    expect(md).toContain('`AWS_BUCKET`')
    expect(md).toContain('`GOOGLE_CLIENT_ID`')
    expect(md).toContain('Auto-générée')
  })

  it('keeps env table consistent with .env.example output', () => {
    const md = generateReadme(fullSpec)
    const env = generateEnvExample(fullSpec)
    for (const v of getRequiredEnvVars(fullSpec)) {
      expect(md).toContain(`\`${v.name}\``)
      expect(env).toContain(`${v.name}=`)
    }
  })

  it('mentions RBAC roles when permissions are declared', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('### Product')
    expect(md).toMatch(/POST \/products[^\n]*`admin`/)
    expect(md).toMatch(/GET \/products\/:id[^\n]*`customer`/)
    expect(md).toContain('`customer` (ses propres ressources)')
  })

  it('lists custom endpoints', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('POST /orders/:id/refund')
    expect(md).toContain('endpoint personnalisé')
  })

  it('renders nested endpoints when relations exist', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('GET /orders/:id/products')
  })

  it('renders the upload section with the configured limits', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('## 📎 Upload de fichiers')
    expect(md).toContain('POST /upload')
    expect(md).toContain('10 MB')
    expect(md).toContain('`image/png`')
  })

  it('renders the webhooks section with declared events', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('## 🪝 Webhooks')
    expect(md).toContain('`order.created`')
    expect(md).toContain('`order.paid`')
    expect(md).toContain('Sortants')
    expect(md).toContain('Entrants')
    expect(md).toContain('POST /webhooks/inbound/stripe')
    expect(md).toContain('x-webhook-signature')
  })

  it('renders the search section using pagination defaults from the spec', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('## 🔍 Recherche & filtres')
    expect(md).toContain('?q=')
    expect(md).toContain('?sort=')
    expect(md).toContain('?page=1&limit=25')
    expect(md).toContain('max 200')
  })

  it('renders curl examples that use real fields and the spec base URL', () => {
    const md = generateReadme(fullSpec)
    expect(md).toContain('## 💡 Exemples')
    expect(md).toContain('curl -X POST https://api.shop.example/products')
    expect(md).toContain('"title"')
    expect(md).toContain('"price"')
    expect(md).toContain('Authorization: Bearer VOTRE_TOKEN')
  })
})

describe('generateReadme — adaptation per feature', () => {
  it('omits the OAuth subsection when no providers are configured', () => {
    const spec: ZeroAPISpec = {
      ...minimalSpec,
      auth: { jwt: { enabled: true } },
    }
    const md = generateReadme(spec)
    expect(md).toContain('### JWT')
    expect(md).not.toContain('### OAuth')
  })

  it('omits webhook section when no event is declared', () => {
    const spec: ZeroAPISpec = {
      ...minimalSpec,
      features: { webhooks: {} },
    }
    expect(generateReadme(spec)).not.toContain('## 🪝 Webhooks')
  })

  it('omits the upload section when fileUpload.enabled is false', () => {
    const spec: ZeroAPISpec = {
      ...minimalSpec,
      features: { fileUpload: { enabled: false, provider: 'local', maxSizeMB: 1, allowedTypes: [] } },
    }
    expect(generateReadme(spec)).not.toContain('## 📎 Upload de fichiers')
  })

  it('shows the search section when only pagination is configured', () => {
    const spec: ZeroAPISpec = {
      ...minimalSpec,
      features: { pagination: { defaultLimit: 50, maxLimit: 500 } },
    }
    const md = generateReadme(spec)
    expect(md).toContain('## 🔍 Recherche & filtres')
    expect(md).toContain('?page=1&limit=50')
    expect(md).not.toContain('?q=')
  })

  it('limits curl example fields to the resource\'s real required fields', () => {
    const spec: ZeroAPISpec = {
      version: '1.0.0',
      name: 'product-api',
      resources: [
        {
          name: 'Product',
          fields: {
            title: { type: 'string', required: true },
            price: { type: 'decimal', required: true },
            color: { type: 'string', required: false },
          },
        },
      ],
    }
    const md = generateReadme(spec)
    expect(md).toContain('"title"')
    expect(md).toContain('"price"')
    expect(md).not.toContain('"color"')
  })

  it('respects custom secretEnv when generating the env table', () => {
    const spec: ZeroAPISpec = {
      ...minimalSpec,
      auth: { jwt: { enabled: true, secretEnv: 'CUSTOM_TOKEN' } },
    }
    const md = generateReadme(spec)
    expect(md).toContain('`CUSTOM_TOKEN`')
    expect(md).not.toContain('`JWT_SECRET`')
  })
})
