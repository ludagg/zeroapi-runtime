import { parseSpec } from '../src/index.js'

/**
 * One realistic spec exercising every Prisma-mode subsystem against a REAL
 * database: persistence (Todo), relations + nested includes (Author/Post/
 * Comment), many-to-many + filtering (Post/Hashtag), self-M2M (Person/Follows),
 * and an ACID transaction (Purchase decrements Product.stock).
 *
 * Shared by the schema generator and the test runner so the schema pushed to
 * Postgres matches the models the runtime queries at runtime.
 */
export const spec = parseSpec({
  version: '1.0.0',
  name: 'realdb-e2e',
  resources: [
    // ── persistence ──
    {
      name: 'Todo',
      fields: {
        title: { type: 'string', required: true },
        done: { type: 'boolean', required: false, default: false },
      },
    },

    // ── relations / nested includes ──
    { name: 'Author', fields: { name: { type: 'string', required: true } } },
    {
      name: 'Post',
      fields: { title: { type: 'string', required: true } },
      relations: [
        { type: 'oneToMany', resource: 'Comment' },
        { type: 'manyToMany', resource: 'Hashtag', through: 'PostHashtags' },
      ],
    },
    {
      name: 'Comment',
      fields: { text: { type: 'string', required: true } },
      relations: [
        { type: 'manyToOne', resource: 'Post', field: 'postId', required: true },
        { type: 'manyToOne', resource: 'Author', field: 'authorId', required: true },
      ],
    },
    { name: 'Hashtag', fields: { label: { type: 'string', required: true } } },

    // ── self many-to-many ──
    {
      name: 'Person',
      fields: { handle: { type: 'string', required: true } },
      relations: [{ type: 'manyToMany', resource: 'Person', through: 'Follows' }],
    },

    // ── ACID transaction ──
    {
      name: 'Product',
      fields: {
        name: { type: 'string', required: true },
        stock: { type: 'integer', required: true, min: 0 },
      },
    },
    {
      name: 'Purchase',
      fields: {
        productId: { type: 'uuid', required: true },
        quantity: { type: 'integer', required: true, min: 1 },
      },
      relations: [{ type: 'manyToOne', resource: 'Product', field: 'productId', required: true }],
      transactions: [
        {
          trigger: 'POST',
          operations: [
            { action: 'decrement', resource: 'Product', idFrom: 'productId', field: 'stock', amountFrom: 'quantity' },
          ],
        },
      ],
    },
  ],
})
