import { parseSpec } from '../src/index.js'
export const spec = parseSpec({
  version: '1.0.0',
  name: 'webhooks-e2e',
  features: { webhooks: { outbound: ['order.created'] } },
  resources: [
    { name: 'Order', fields: { item: { type: 'string', required: true } } },
  ],
})
