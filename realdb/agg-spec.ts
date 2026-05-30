import { parseSpec } from '../src/index.js'

/** Aggregates spec for real-DB verification (User 1—N Order / Comment). */
export const spec = parseSpec({
  version: '1.0.0',
  name: 'realdb-agg',
  resources: [
    {
      name: 'Account',
      fields: { name: { type: 'string', required: true } },
      relations: [
        { type: 'oneToMany', resource: 'Order' },
        { type: 'oneToMany', resource: 'Comment' },
      ],
      aggregates: [
        { name: 'orderCount', op: 'count', relation: 'orders' },
        { name: 'totalSpent', op: 'sum', relation: 'orders', field: 'total' },
        { name: 'avgOrder', op: 'avg', relation: 'orders', field: 'total' },
        { name: 'minOrder', op: 'min', relation: 'orders', field: 'total' },
        { name: 'maxOrder', op: 'max', relation: 'orders', field: 'total' },
        { name: 'commentCount', op: 'count', relation: 'comments' },
      ],
    },
    {
      name: 'Order',
      fields: { total: { type: 'integer', required: true } },
      relations: [{ type: 'manyToOne', resource: 'Account', field: 'accountId', required: true }],
    },
    {
      name: 'Comment',
      fields: { text: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'Account', field: 'accountId', required: true }],
    },
  ],
})
