/**
 * Basic API example — no auth, no RBAC.
 * Run with: npx tsx examples/basic-api/index.ts
 */
import { parseSpec, createRuntime } from '../../src/index.js'

const spec = parseSpec({
  version: '1.0.0',
  name: 'basic-api',
  description: 'A minimal API with two resources and no authentication',
  resources: [
    {
      name: 'Todo',
      description: 'Simple to-do items',
      fields: {
        title:     { type: 'string',  required: true, minLength: 1, maxLength: 200 },
        done:      { type: 'boolean', required: false, default: false },
        dueDate:   { type: 'datetime', required: false },
      },
    },
    {
      name: 'Tag',
      description: 'Labels for todos',
      fields: {
        name:  { type: 'string', required: true, unique: true, maxLength: 50 },
        color: { type: 'string', required: false, default: '#cccccc' },
      },
    },
  ],
})

const { app, prismaSchema, testSuite } = createRuntime(spec)

// Available endpoints:
//   GET  /health
//   GET  /openapi.json
//   GET  /docs
//   GET    /todos
//   POST   /todos
//   GET    /todos/:id
//   PUT    /todos/:id
//   DELETE /todos/:id
//   GET    /tags
//   POST   /tags
//   GET    /tags/:id
//   PUT    /tags/:id
//   DELETE /tags/:id

console.log('=== Basic API ===')
console.log('Routes: /todos, /tags')
console.log('Docs:   /docs')
console.log()
console.log('--- Prisma Schema ---')
console.log(prismaSchema)
console.log('--- Generated Test Suite (first 20 lines) ---')
console.log(testSuite.split('\n').slice(0, 20).join('\n'))

export { app }
