import type { ZeroAPISpec } from '../../src/types/spec.js'

export const sampleSpec: ZeroAPISpec = {
  version: '1.0.0',
  name: 'test-api',
  description: 'Sample API for testing purposes',
  resources: [
    {
      name: 'User',
      description: 'Platform users',
      fields: {
        name: { type: 'string', required: true, minLength: 2, maxLength: 50 },
        email: { type: 'email', required: true, unique: true },
        age: { type: 'integer', required: false, min: 0, max: 150 },
        bio: { type: 'text', required: false, maxLength: 500 },
      },
    },
    {
      name: 'Post',
      description: 'Blog posts',
      fields: {
        title: { type: 'string', required: true, minLength: 1, maxLength: 200 },
        content: { type: 'text', required: true },
        published: { type: 'boolean', required: false, default: false },
      },
      endpoints: ['list', 'create', 'read', 'update', 'delete'],
    },
  ],
}

export const minimalSpec: ZeroAPISpec = {
  version: '0.1.0',
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
