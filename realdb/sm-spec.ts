import { parseSpec } from '../src/index.js'

/** State-machine spec for real-DB verification. */
export const spec = parseSpec({
  version: '1.0.0',
  name: 'realdb-sm',
  auth: { enabled: true, strategies: ['jwt'], jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
  resources: [{
    name: 'Post',
    fields: {
      title: { type: 'string', required: true },
      status: { type: 'enum', values: ['draft', 'published', 'archived'], default: 'draft' },
    },
    stateMachine: {
      field: 'status',
      initial: 'draft',
      transitions: [
        { from: 'draft', to: 'published', roles: ['editor', 'admin'] },
        { from: 'published', to: 'archived', roles: ['admin'] },
        { from: 'archived', to: 'draft', roles: ['admin'] },
      ],
    },
  }],
  permissions: [{
    resource: 'Post',
    rules: [
      { role: 'editor', actions: ['create', 'read', 'update'] },
      { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
    ],
  }],
})
