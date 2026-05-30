import { parseSpec } from '../src/index.js'

/** Multi-tenant scope spec for real-DB verification (Document scoped by org). */
export const spec = parseSpec({
  version: '1.0.0',
  name: 'realdb-scope',
  auth: { enabled: true, strategies: ['jwt'], jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
  resources: [
    {
      name: 'Document',
      fields: {
        title: { type: 'string', required: true },
        organizationId: { type: 'string', required: false },
      },
    },
  ],
  permissions: [
    {
      resource: 'Document',
      rules: [
        { role: 'member', actions: ['create', 'read', 'update', 'delete'], scope: { column: 'organizationId', claim: 'org' } },
      ],
    },
  ],
})
