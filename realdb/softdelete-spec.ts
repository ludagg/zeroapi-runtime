import { parseSpec } from '../src/index.js'
export const spec = parseSpec({
  version: '1.0.0',
  name: 'softdelete-e2e',
  resources: [
    {
      name: 'Note',
      fields: { title: { type: 'string', required: true } },
      softDelete: true,
    },
  ],
})
