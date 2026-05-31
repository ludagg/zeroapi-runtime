import { parseSpec } from '../src/index.js'

/**
 * Spec dedicated to proving P0-1 — SQL query pushdown in Prisma mode.
 *
 * `Product` carries enough shape to exercise every pushdown path against a REAL
 * Postgres database:
 *   - filtering   (?status=, ?price[gte]=)         → SQL WHERE
 *   - type coerce (?sku=12345 on a String column)  → SQL WHERE (no 500)
 *   - sorting     (?sort=price:desc)               → SQL ORDER BY
 *   - pagination  (?page=&limit= / ?cursor=)       → SQL LIMIT/OFFSET
 *   - search      (?q=)                            → SQL WHERE … ILIKE
 *   - scope        (organizationId ↔ JWT `org`)    → tenant isolation in WHERE
 */
export const spec = parseSpec({
  version: '1.0.0',
  name: 'pushdown-e2e',
  auth: { jwt: { enabled: true } },
  features: { search: { enabled: true } },
  permissions: [
    {
      resource: 'Product',
      rules: [
        {
          role: 'member',
          actions: ['create', 'read', 'update', 'delete'],
          scope: { column: 'organizationId', claim: 'org' },
        },
      ],
    },
  ],
  resources: [
    {
      name: 'Product',
      fields: {
        name: { type: 'string', required: true },
        description: { type: 'text', required: false },
        // String column whose values look numeric — proves filter type coercion.
        sku: { type: 'string', required: true },
        status: { type: 'enum', required: true, values: ['active', 'archived', 'draft'] },
        price: { type: 'integer', required: true },
        organizationId: { type: 'string', required: true },
      },
      searchable: ['name', 'description'],
    },
  ],
})
