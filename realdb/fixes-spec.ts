import { parseSpec } from '../src/index.js'

/** Spec covering the three finition fixes, for real-DB verification. */
export const spec = parseSpec({
  version: '1.0.0',
  name: 'realdb-fixes',
  auth: { enabled: true, strategies: ['jwt'], jwt: { enabled: true, secretEnv: 'JWT_SECRET' } },
  resources: [
    // Fix 1 — ownOnly on included relations
    { name: 'Board', fields: { title: { type: 'string', required: true } },
      relations: [{ type: 'oneToMany', resource: 'Note' }] },
    { name: 'Note', fields: { text: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'Board', field: 'boardId', required: true }] },

    // Fix 2 — M2M filtering through an association entity with a CUSTOM fk
    { name: 'Order', fields: { ref: { type: 'string', required: true } },
      relations: [{ type: 'manyToMany', resource: 'Product', through: 'OrderItem' }] },
    { name: 'Product', fields: { name: { type: 'string', required: true } } },
    { name: 'OrderItem', fields: { qty: { type: 'integer', required: true } },
      relations: [
        { type: 'manyToOne', resource: 'Order', field: 'orderId', required: true },
        { type: 'manyToOne', resource: 'Product', field: 'prodRef', required: true },
      ] },

    // Fix 3 — self-M2M with named directions
    { name: 'Person', fields: { handle: { type: 'string', required: true } },
      relations: [{ type: 'manyToMany', resource: 'Person', through: 'Follows', as: 'following', reverseAs: 'followers' }] },
  ],
  permissions: [
    { resource: 'Board', rules: [{ role: 'user', actions: ['read', 'create'] }] },
    { resource: 'Note', rules: [{ role: 'user', actions: ['read', 'create', 'update', 'delete'], ownOnly: true }] },
  ],
})
